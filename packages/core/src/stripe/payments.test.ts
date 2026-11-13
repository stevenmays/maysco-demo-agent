import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { payloadHash, StripePayments } from "./payments.js";

function stripeWithBank(id: string) {
  const account = {
    country: "US",
    company: { name: "Orlenka Freight LLC" },
    external_accounts: {
      data: [
        {
          object: "bank_account",
          id,
          fingerprint: "same",
          last4: "6789",
          default_for_currency: true,
        },
      ],
    },
  };
  return { accounts: { retrieve: async () => account } } as unknown as Stripe;
}

describe("StripePayments.getSeller", () => {
  it("treats a new bank record as a change even with the same account number", async () => {
    const before = await new StripePayments(stripeWithBank("ba_1")).getSeller("acct_1");
    const after = await new StripePayments(stripeWithBank("ba_2")).getSeller("acct_1");
    const saga = { amount: 11_250, currency: "usd" };
    expect(payloadHash(saga, after)).not.toBe(payloadHash(saga, before));
  });
});
