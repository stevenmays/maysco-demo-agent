import type { Deps } from "../deps.js";
import { renderCard } from "./card.js";

/**
 * Makes Slack match the database: one card per saga, updated in place, and one
 * thread reply per history row. Slack has no idempotency key, so a crash between
 * posting and saving `slack_ts` can post a second card. Its buttons stay safe
 * because every decision is checked against the saga row.
 */
export async function syncSlack(deps: Deps, sagaId: string): Promise<void> {
  const { db, chat } = deps;
  const saga = await db.selectFrom("sagas").selectAll().where("id", "=", sagaId).executeTakeFirst();
  if (!saga) return;
  const channel = saga.slack_channel ?? deps.config.slackChannel;
  const approvals = await db
    .selectFrom("approvals")
    .select(["reviewer", "reviewer_name"])
    .where("saga_id", "=", saga.id)
    .where("payload_hash", "=", saga.payload_hash ?? "")
    .where("decision", "=", "approve")
    .execute();
  const card = renderCard(saga, approvals);

  let ts = saga.slack_ts;
  if (ts) {
    await chat.update(channel, ts, card);
  } else {
    ts = await chat.post(channel, card);
    await db
      .updateTable("sagas")
      .set({ slack_ts: ts, slack_channel: channel })
      .where("id", "=", saga.id)
      .execute();
  }

  const pending = await db
    .selectFrom("saga_history")
    .select(["id", "actor", "note"])
    .where("saga_id", "=", saga.id)
    .where("slack_posted_at", "is", null)
    .orderBy("id")
    .execute();
  for (const entry of pending) {
    await chat.reply(channel, ts, `*${entry.actor}:* ${entry.note}`);
    await db
      .updateTable("saga_history")
      .set({ slack_posted_at: new Date() })
      .where("id", "=", entry.id)
      .execute();
  }
}
