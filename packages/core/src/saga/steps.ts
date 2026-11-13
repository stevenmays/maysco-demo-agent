import type { Saga } from "../db/types.js";
import type { Deps } from "../deps.js";
import { minutesFromNow } from "../deps.js";
import { post } from "../ledger.js";
import { type AssessmentResult, decide, THRESHOLDS } from "../policy.js";
import { loadEntities } from "../screening/entities.js";
import { topCandidates } from "../screening/match.js";
import { nameScore } from "../screening/similarity.js";
import type { Screening } from "../slack/card.js";
import { payloadHash } from "../stripe/payments.js";
import { advance, transition } from "./transition.js";
import { commit } from "./unit-of-work.js";

/** Thrown for failures a later attempt may fix. SQS redelivers the message. */
export class RetryLater extends Error {}

export const MAX_MODEL_ATTEMPTS = 3;

export async function screen(deps: Deps, saga: Saga, attempt: number): Promise<void> {
  const seller = await deps.payments.getSeller(saga.seller_account_id);
  // Full-text search returns the nearest record; keep it only if it's the same name.
  const found = await deps.findLei(seller.legalName);
  const lei = found && nameScore(found.legalName, seller.legalName) >= 0.9 ? found : null;
  await deps.db
    .updateTable("sellers")
    .set({
      legal_name: seller.legalName,
      country: seller.country,
      lei: lei?.lei ?? null,
      updated_at: new Date(),
    })
    .where("stripe_account_id", "=", seller.accountId)
    .execute();

  // Regular code decides what it can. The model only sees names that code can't settle.
  const candidates = topCandidates(seller.legalName, await loadEntities(deps.db));
  const topScore = candidates[0]?.score ?? 0;
  let result: AssessmentResult = { kind: "skipped" };
  if (topScore >= THRESHOLDS.askModel && topScore < THRESHOLDS.strong) {
    const outcome = await deps.assessor.assess({
      seller: { legalName: seller.legalName, country: seller.country, lei },
      candidates,
      maxOutputTokens: saga.chaos === "llm_max_tokens" ? 64 : undefined,
    });
    await deps.db
      .insertInto("llm_calls")
      .values({
        saga_id: saga.id,
        model: outcome.call.model,
        input_tokens: outcome.call.inputTokens,
        output_tokens: outcome.call.outputTokens,
        stop_reason: outcome.call.stopReason,
        outcome: outcome.call.outcome,
        latency_ms: outcome.call.latencyMs,
      })
      .execute();
    if (outcome.kind === "failed" && outcome.retryable && attempt < MAX_MODEL_ATTEMPTS) {
      throw new RetryLater(outcome.reason);
    }
    result =
      outcome.kind === "ok"
        ? { kind: "ok", assessment: outcome.assessment }
        : { kind: "failed", reason: outcome.reason };
  }

  const decision = decide(topScore, result, saga.amount);
  const agentSummary =
    decision.tier === "agent_clear" && result.kind === "ok" ? result.assessment.summary : null;
  const screening: Screening = {
    seller: { legalName: seller.legalName, country: seller.country },
    lei,
    candidates: candidates.slice(0, 3).map((c) => ({
      name: c.entity.name,
      matchedName: c.matchedName,
      program: c.entity.program,
      score: c.score,
    })),
    assessment: result.kind === "ok" ? result.assessment : null,
    decision,
  };
  const patch = {
    payload_hash: payloadHash(saga, seller),
    risk_tier: decision.tier,
    required_approvals: decision.requiredApprovals,
    screening: JSON.stringify(screening),
    slack_channel: deps.config.slackChannel,
  };

  await commit(deps.db, deps.queue, async (tx) => {
    if (decision.tier === "clear" || decision.tier === "agent_clear") {
      const moved = await transition(tx, saga, "cleared", {
        actor: agentSummary ? "agent" : "policy",
        note: agentSummary
          ? `Cleared without a reviewer. ${agentSummary} ${decision.reason}.`
          : `Cleared automatically. ${decision.reason}.`,
        patch,
      });
      if (moved) await advance(tx, saga.id, "cleared");
      return;
    }
    const n = decision.requiredApprovals;
    await transition(tx, saga, "awaiting_review", {
      actor: result.kind === "ok" ? "agent" : "policy",
      note: `Needs ${n} reviewer${n > 1 ? "s" : ""}. ${decision.reason}.`,
      patch: {
        ...patch,
        remind_at: minutesFromNow(deps.config.remindAfterMinutes),
        review_expires_at: minutesFromNow(deps.config.reviewTtlMinutes),
        reminded_at: null,
      },
    });
  });
}

/** Executor check: the transfer goes out only if the seller still matches what was approved. */
export async function startTransfer(deps: Deps, saga: Saga): Promise<void> {
  const seller = await deps.payments.getSeller(saga.seller_account_id);
  const unchanged = payloadHash(saga, seller) === saga.payload_hash;
  await commit(deps.db, deps.queue, async (tx) => {
    if (!unchanged) {
      const moved = await transition(tx, saga, "received", {
        actor: "executor",
        note: "The seller's details changed after review. The approval no longer applies. Screening again.",
      });
      if (moved) await advance(tx, saga.id, "received");
      return;
    }
    const moved = await transition(tx, saga, "transferring", {
      actor: "executor",
      note: "Sending the transfer.",
    });
    if (moved) await advance(tx, saga.id, "transferring");
  });
}

export async function completeTransfer(deps: Deps, saga: Saga): Promise<void> {
  const transferId =
    saga.transfer_id ??
    (await deps.payments.findTransfer(saga.id, saga.seller_account_id)) ??
    (await deps.payments.createTransfer({
      sagaId: saga.id,
      amount: saga.amount,
      currency: saga.currency,
      destination: saga.seller_account_id,
      sourceTransaction: saga.charge_id,
      idempotencyKey: `transfer:${saga.id}:${saga.payload_hash}`,
    }));
  await commit(deps.db, deps.queue, async (tx) => {
    const moved = await transition(tx, saga, "paid", {
      actor: "executor",
      note: `Paid. Stripe transfer \`${transferId}\`.`,
      patch: { transfer_id: transferId },
    });
    if (moved) await post(tx.trx, saga, "payoutSent", `Transfer ${transferId}`);
  });
}

export async function completeReversal(deps: Deps, saga: Saga): Promise<void> {
  if (!saga.transfer_id) throw new Error(`Saga ${saga.id} is reversing without a transfer`);
  await deps.payments.reverseTransfer(saga.transfer_id, `reverse:${saga.id}`);
  await commit(deps.db, deps.queue, async (tx) => {
    const moved = await transition(tx, saga, "held", {
      actor: "executor",
      note: `Reversed transfer \`${saga.transfer_id}\`. Funds are held.`,
    });
    if (moved) await post(tx.trx, saga, "transferReversed", `Reversal of ${saga.transfer_id}`);
  });
}
