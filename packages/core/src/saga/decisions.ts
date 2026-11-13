import type { Deps } from "../deps.js";
import { post } from "../ledger.js";
import type { QueueMessage } from "../messages.js";
import { advance, record, transition } from "./transition.js";
import { commit } from "./unit-of-work.js";

type DecisionMessage = Extract<QueueMessage, { kind: "slack.decision" }>;

/**
 * Applies one button click. The row lock serializes reviewers, so two clicks at the
 * same moment produce one decision, and two different reviewers can't both count
 * as "the first of two".
 */
export async function recordDecision(deps: Deps, msg: DecisionMessage): Promise<void> {
  const outcome = await commit(deps.db, deps.queue, async (tx) => {
    const saga = await tx.trx
      .selectFrom("sagas")
      .selectAll()
      .where("id", "=", msg.sagaId)
      .forUpdate()
      .executeTakeFirst();
    if (!saga) return { channel: null, reply: "This review no longer exists." };
    const channel = saga.slack_channel;

    if (saga.status !== "awaiting_review") {
      const last = await tx.trx
        .selectFrom("saga_history")
        .select(["actor", "to_status"])
        .where("saga_id", "=", saga.id)
        .where("to_status", "in", ["approved", "held"])
        .orderBy("id", "desc")
        .executeTakeFirst();
      return {
        channel,
        reply: last
          ? `This review is closed. It was ${last.to_status} by ${last.actor}.`
          : "This review is closed.",
      };
    }
    if (msg.payloadHash !== saga.payload_hash) {
      return {
        channel,
        reply:
          "This card is out of date. The seller's details changed, so review the updated card.",
      };
    }

    if (msg.decision === "reject") {
      await tx.trx
        .insertInto("approvals")
        .values({
          saga_id: saga.id,
          reviewer: msg.reviewer,
          reviewer_name: msg.reviewerName,
          decision: "reject",
          payload_hash: msg.payloadHash,
          reason: msg.reason,
        })
        .onConflict((oc) =>
          oc
            .columns(["saga_id", "reviewer", "payload_hash"])
            .doUpdateSet({ decision: "reject", reason: msg.reason }),
        )
        .execute();
      const moved = await transition(tx, saga, "held", {
        actor: msg.reviewerName,
        note: `Rejected: ${msg.reason ?? "no reason given"}. Funds are held.`,
      });
      if (moved) await post(tx.trx, saga, "fundsHeld", `Rejected by ${msg.reviewerName}`);
      return { channel, reply: null };
    }

    const inserted = await tx.trx
      .insertInto("approvals")
      .values({
        saga_id: saga.id,
        reviewer: msg.reviewer,
        reviewer_name: msg.reviewerName,
        decision: "approve",
        payload_hash: msg.payloadHash,
        reason: null,
      })
      .onConflict((oc) => oc.columns(["saga_id", "reviewer", "payload_hash"]).doNothing())
      .returning("reviewer")
      .executeTakeFirst();
    if (!inserted) {
      return {
        channel,
        reply:
          "You already approved this payout. The next approval must come from a different reviewer.",
      };
    }

    const approvers = await tx.trx
      .selectFrom("approvals")
      .select("reviewer_name")
      .where("saga_id", "=", saga.id)
      .where("payload_hash", "=", saga.payload_hash)
      .where("decision", "=", "approve")
      .execute();
    if (approvers.length >= saga.required_approvals) {
      const moved = await transition(tx, saga, "approved", {
        actor: msg.reviewerName,
        note: `Approved by ${approvers.map((a) => a.reviewer_name).join(" and ")}.`,
      });
      if (moved) await advance(tx, saga.id, "approved");
    } else {
      await record(tx, saga.id, {
        actor: msg.reviewerName,
        note: `Approved (${approvers.length} of ${saga.required_approvals}). The next approval must come from a different reviewer.`,
      });
    }
    return { channel, reply: null };
  });

  if (outcome.reply && outcome.channel) {
    await deps.chat.ephemeral(outcome.channel, msg.reviewer, outcome.reply);
  }
}
