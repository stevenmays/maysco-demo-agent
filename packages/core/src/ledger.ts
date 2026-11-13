import type { Transaction } from "kysely";
import type { Database, Saga } from "./db/types.js";

export interface Posting {
  account: string;
  amount: number;
}

const cash = "platform_cash";
const payable = (s: Saga) => `seller_payable:${s.seller_account_id}`;
const held = (s: Saga) => `held_payable:${s.seller_account_id}`;

// Debits are positive, credits negative. Every journal entry sums to zero.
export const journal = {
  paymentReceived: (s: Saga): Posting[] => [
    { account: cash, amount: s.amount },
    { account: payable(s), amount: -s.amount },
  ],
  payoutSent: (s: Saga): Posting[] => [
    { account: payable(s), amount: s.amount },
    { account: cash, amount: -s.amount },
  ],
  fundsHeld: (s: Saga): Posting[] => [
    { account: payable(s), amount: s.amount },
    { account: held(s), amount: -s.amount },
  ],
  transferReversed: (s: Saga): Posting[] => [
    { account: cash, amount: s.amount },
    { account: held(s), amount: -s.amount },
  ],
};

export async function post(
  trx: Transaction<Database>,
  saga: Saga,
  kind: keyof typeof journal,
  memo: string,
): Promise<void> {
  const postings = journal[kind](saga);
  const sum = postings.reduce((total, p) => total + p.amount, 0);
  if (sum !== 0) throw new Error(`Unbalanced journal entry ${kind}: ${sum}`);
  // The txn id makes a replayed step post nothing new.
  await trx
    .insertInto("ledger_entries")
    .values(postings.map((p) => ({ ...p, txn_id: `${saga.id}:${kind}`, saga_id: saga.id, memo })))
    .onConflict((oc) => oc.columns(["txn_id", "account"]).doNothing())
    .execute();
}
