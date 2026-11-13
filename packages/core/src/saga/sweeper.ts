import { sql } from "kysely";
import type { Deps } from "../deps.js";
import { post } from "../ledger.js";
import type { QueueMessage } from "../messages.js";
import { record, transition } from "./transition.js";
import { commit, dispatch } from "./unit-of-work.js";

export interface SweepResult {
  resent: number;
  reminded: number;
  expired: number;
  resynced: number;
}

/**
 * Polling publisher and timer in one. Every minute it resends outbox rows that a
 * dead Lambda committed but never sent, then reminds, expires, and repairs Slack.
 */
export async function sweep(deps: Deps, staleAfterSeconds = 60): Promise<SweepResult> {
  const { db, queue } = deps;
  const cutoff = sql<Date>`now() - make_interval(secs => ${staleAfterSeconds})`;

  const lost = await db
    .selectFrom("outbox")
    .select([
      "id",
      "saga_id",
      "message",
      sql<number>`extract(epoch from now() - created_at)`.as("age"),
    ])
    .where("dispatched_at", "is", null)
    .where("created_at", "<", cutoff)
    .orderBy("id")
    .limit(100)
    .execute();
  for (const row of lost) {
    const message = row.message as QueueMessage;
    if (message.kind !== "saga.advance" || !row.saga_id) continue;
    const sagaId = row.saga_id;
    await commit(db, queue, (tx) =>
      record(tx, sagaId, {
        actor: "sweeper",
        note: `Found a step message that was saved but never sent (${Math.round(Number(row.age))} s old). Sent it now.`,
      }),
    );
  }
  const resent = await dispatch(
    db,
    queue,
    lost.map((r) => r.id),
    "sweeper",
  );

  const due = await db
    .selectFrom("sagas")
    .selectAll()
    .where("status", "=", "awaiting_review")
    .where((eb) =>
      eb.or([
        eb("review_expires_at", "<", sql<Date>`now()`),
        eb.and([eb("remind_at", "<", sql<Date>`now()`), eb("reminded_at", "is", null)]),
      ]),
    )
    .execute();
  let reminded = 0;
  let expired = 0;
  for (const saga of due) {
    if (saga.review_expires_at && saga.review_expires_at < new Date()) {
      await commit(db, queue, async (tx) => {
        const moved = await transition(tx, saga, "held", {
          actor: "sweeper",
          note: "Nobody reviewed this in time. The payout expired and funds stay held.",
        });
        if (moved) {
          await post(tx.trx, saga, "fundsHeld", "Review expired");
          expired++;
        }
      });
      continue;
    }
    await commit(db, queue, async (tx) => {
      const updated = await tx.trx
        .updateTable("sagas")
        .set({ reminded_at: new Date() })
        .where("id", "=", saga.id)
        .where("reminded_at", "is", null)
        .executeTakeFirst();
      if (updated.numUpdatedRows === 0n) return;
      await record(tx, saga.id, {
        actor: "sweeper",
        note: `<!here> Reminder: this payout is still waiting for review. It expires at ${saga.review_expires_at?.toISOString().slice(11, 16)} UTC.`,
      });
      reminded++;
    });
  }

  // Slack calls that failed past their retries leave history rows unposted.
  const unsynced = await db
    .selectFrom("saga_history")
    .select("saga_id")
    .distinct()
    .where("slack_posted_at", "is", null)
    .where("created_at", "<", sql<Date>`now() - interval '2 minutes'`)
    .limit(50)
    .execute();
  for (const { saga_id } of unsynced) {
    await commit(db, queue, (tx) => tx.emit(saga_id, { kind: "slack.sync", sagaId: saga_id }));
  }

  return { resent, reminded, expired, resynced: unsynced.length };
}
