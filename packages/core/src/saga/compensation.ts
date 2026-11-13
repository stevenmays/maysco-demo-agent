import type { Deps } from "../deps.js";
import { THRESHOLDS } from "../policy.js";
import { topCandidates } from "../screening/match.js";
import { payloadHash } from "../stripe/payments.js";
import { BEFORE_TRANSFER } from "./states.js";
import { advance, transition } from "./transition.js";
import { commit } from "./unit-of-work.js";

/** A bank-details change sends every unpaid saga for that seller back to screening. */
export async function onSellerChanged(deps: Deps, accountId: string): Promise<void> {
  const seller = await deps.payments.getSeller(accountId);
  const sagas = await deps.db
    .selectFrom("sagas")
    .selectAll()
    .where("seller_account_id", "=", accountId)
    .where("status", "in", ["awaiting_review", "cleared", "approved"])
    .execute();
  for (const saga of sagas) {
    if (payloadHash(saga, seller) === saga.payload_hash) continue;
    await commit(deps.db, deps.queue, async (tx) => {
      const moved = await transition(tx, saga, "received", {
        actor: "stripe",
        note: "The seller's bank details changed. Earlier approvals no longer apply. Screening again.",
      });
      if (moved) await advance(tx, saga.id, "received");
    });
  }
}

/**
 * New sanctions entries re-check every seller. Unpaid sagas go back to screening.
 * Paid ones can't be screened again, so the compensating step reverses the transfer.
 */
export async function onListChanged(deps: Deps, added: number[]): Promise<void> {
  if (added.length === 0) return;
  const entities = await deps.db
    .selectFrom("sanctions_entities")
    .selectAll()
    .where("ent_num", "in", added)
    .execute();
  const sellers = await deps.db
    .selectFrom("sellers")
    .select(["stripe_account_id", "legal_name"])
    .where("legal_name", "is not", null)
    .execute();

  for (const seller of sellers) {
    const [hit] = topCandidates(seller.legal_name!, entities, 1);
    if (!hit || hit.score < THRESHOLDS.review) continue;
    const sagas = await deps.db
      .selectFrom("sagas")
      .selectAll()
      .where("seller_account_id", "=", seller.stripe_account_id)
      .where("status", "in", [...BEFORE_TRANSFER, "paid"])
      .execute();
    const entry = `${hit.entity.name} (${hit.entity.program}), name score ${hit.score.toFixed(2)}`;
    for (const saga of sagas) {
      if (saga.status === "received") continue;
      await commit(deps.db, deps.queue, async (tx) => {
        if (saga.status === "paid") {
          const moved = await transition(tx, saga, "reversing", {
            actor: "sanctions poller",
            note: `A new SDN entry matches this seller after payout: ${entry}. Reversing the transfer.`,
          });
          if (moved) await advance(tx, saga.id, "reversing");
          return;
        }
        const moved = await transition(tx, saga, "received", {
          actor: "sanctions poller",
          note: `A new SDN entry matches this seller: ${entry}. Screening again.`,
        });
        if (moved) await advance(tx, saga.id, "received");
      });
    }
  }
}
