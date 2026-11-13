import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "kysely";
import type { Deps } from "../deps.js";
import { renderCard } from "./card.js";

const PENDING = "pending:";
const STALE_CLAIM_MS = 30_000;

/**
 * Makes Slack match the database: one card per saga, updated in place, and one
 * thread reply per history row. Several workers can sync the same saga at once,
 * so each claims the card and the history rows with a conditional update first.
 * Slack has no idempotency key. A crash between posting the card and saving its
 * timestamp can post a second card; its buttons stay safe because every click is
 * checked against the saga row. Thread replies are claimed before they post, so a
 * crash can drop a reply. `saga_history` stays the audit record either way.
 */
export async function syncSlack(deps: Deps, sagaId: string): Promise<void> {
  const ts = await ensureCard(deps, sagaId);
  if (!ts) return;
  await updateCard(deps, sagaId, ts);
  await postHistory(deps, sagaId, ts);
}

async function ensureCard(deps: Deps, sagaId: string): Promise<string | null> {
  const { db, chat } = deps;
  // The claim carries its time, so a claim left by a Lambda that died mid-post expires.
  const claim = `${PENDING}${Date.now()}:${randomUUID()}`;
  const staleBefore = Date.now() - STALE_CLAIM_MS;
  const claimed = await db
    .updateTable("sagas")
    .set({ slack_ts: claim, slack_channel: deps.config.slackChannel })
    .where("id", "=", sagaId)
    .where((eb) =>
      eb.or([
        eb("slack_ts", "is", null),
        eb.and([
          eb("slack_ts", "like", `${PENDING}%`),
          eb(sql<number>`split_part(slack_ts, ':', 2)::bigint`, "<", staleBefore),
        ]),
      ]),
    )
    .returningAll()
    .executeTakeFirst();
  if (claimed) {
    try {
      const ts = await chat.post(deps.config.slackChannel, renderCard(claimed, []));
      await db.updateTable("sagas").set({ slack_ts: ts }).where("id", "=", sagaId).execute();
      return ts;
    } catch (error) {
      await db.updateTable("sagas").set({ slack_ts: null }).where("slack_ts", "=", claim).execute();
      throw error;
    }
  }
  // Another worker is posting the card. Wait for its timestamp, then update it.
  for (let i = 0; i < 20; i++) {
    const row = await db
      .selectFrom("sagas")
      .select("slack_ts")
      .where("id", "=", sagaId)
      .executeTakeFirst();
    if (!row) return null;
    if (row.slack_ts && !row.slack_ts.startsWith(PENDING)) return row.slack_ts;
    await sleep(250);
  }
  throw new Error(`Slack card for saga ${sagaId} is still being posted`);
}

/** Renders from the latest row and repeats if the saga moved while Slack was updating. */
async function updateCard(deps: Deps, sagaId: string, ts: string): Promise<void> {
  const { db, chat } = deps;
  for (let i = 0; i < 3; i++) {
    const saga = await db
      .selectFrom("sagas")
      .selectAll()
      .where("id", "=", sagaId)
      .executeTakeFirstOrThrow();
    const approvals = await db
      .selectFrom("approvals")
      .select(["reviewer", "reviewer_name"])
      .where("saga_id", "=", sagaId)
      .where("payload_hash", "=", saga.payload_hash ?? "")
      .where("decision", "=", "approve")
      .execute();
    await chat.update(
      saga.slack_channel ?? deps.config.slackChannel,
      ts,
      renderCard(saga, approvals),
    );
    const after = await db
      .selectFrom("sagas")
      .select("version")
      .where("id", "=", sagaId)
      .executeTakeFirstOrThrow();
    if (after.version === saga.version) return;
  }
}

async function postHistory(deps: Deps, sagaId: string, ts: string): Promise<void> {
  const { db, chat } = deps;
  const claimed = await db
    .updateTable("saga_history")
    .set({ slack_posted_at: new Date() })
    .where("saga_id", "=", sagaId)
    .where("slack_posted_at", "is", null)
    .returning(["id", "actor", "note"])
    .execute();
  const channel = deps.config.slackChannel;
  for (const entry of claimed.sort((a, b) => a.id - b.id)) {
    try {
      await chat.reply(channel, ts, `*${entry.actor}:* ${entry.note}`);
    } catch (error) {
      // Release the rows not yet posted so a retry or the sweeper posts them.
      await db
        .updateTable("saga_history")
        .set({ slack_posted_at: null })
        .where(
          "id",
          "in",
          claimed.filter((c) => c.id >= entry.id).map((c) => c.id),
        )
        .execute();
      throw error;
    }
  }
}
