import { randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import { post } from "../ledger.js";
import type { Queue } from "../messages.js";
import { advance, record } from "./transition.js";
import { commit, type Tx } from "./unit-of-work.js";

// The marketplace keeps a commission. It also leaves room for Stripe's processing fee,
// because a transfer can't exceed what the charge added to the platform balance.
export const PLATFORM_COMMISSION = 0.1;

export interface PaymentEvent {
  eventId: string;
  paymentIntentId: string;
  chargeId: string | null;
  sellerAccountId: string;
  amount: number;
  currency: string;
  chaos: string | null;
}

/** Records the event ID; false means this event was already handled. */
export async function claim(tx: Tx, source: string, eventId: string): Promise<boolean> {
  const row = await tx.trx
    .insertInto("inbox")
    .values({ source, event_id: eventId })
    .onConflict((oc) => oc.columns(["source", "event_id"]).doNothing())
    .returning("event_id")
    .executeTakeFirst();
  return row !== undefined;
}

export async function startSaga(
  db: Db,
  queue: Queue,
  event: PaymentEvent,
): Promise<"started" | "duplicate"> {
  return commit(
    db,
    queue,
    async (tx) => {
      if (!(await claim(tx, "stripe", event.eventId))) return "duplicate";
      await tx.trx
        .insertInto("sellers")
        .values({
          stripe_account_id: event.sellerAccountId,
          legal_name: null,
          country: null,
          lei: null,
        })
        .onConflict((oc) => oc.column("stripe_account_id").doNothing())
        .execute();
      const saga = await tx.trx
        .insertInto("sagas")
        .values({
          id: randomUUID(),
          seller_account_id: event.sellerAccountId,
          payment_intent_id: event.paymentIntentId,
          charge_id: event.chargeId,
          amount: Math.round(event.amount * (1 - PLATFORM_COMMISSION)),
          gross_amount: event.amount,
          currency: event.currency,
          status: "received",
          payload_hash: null,
          risk_tier: null,
          screening: null,
          transfer_id: null,
          slack_channel: null,
          slack_ts: null,
          chaos: event.chaos,
          remind_at: null,
          reminded_at: null,
          review_expires_at: null,
        })
        .onConflict((oc) => oc.column("payment_intent_id").doNothing())
        .returningAll()
        .executeTakeFirst();
      if (!saga) return "duplicate";
      await post(tx.trx, saga, "paymentReceived", `Payment ${event.paymentIntentId}`);
      await record(tx, saga.id, {
        to: "received",
        actor: "stripe",
        note: `Buyer payment \`${event.paymentIntentId}\` succeeded. Screening the seller.`,
      });
      await advance(tx, saga.id, "received");
      return "started";
    },
    { skipDispatch: event.chaos === "skip_dispatch" },
  );
}

export async function sellerChanged(db: Db, queue: Queue, eventId: string, accountId: string) {
  return commit(db, queue, async (tx) => {
    if (!(await claim(tx, "stripe-connect", eventId))) return "duplicate";
    await tx.emit(null, { kind: "seller.changed", accountId });
    return "queued";
  });
}
