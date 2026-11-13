import { createHash } from "node:crypto";
import type Stripe from "stripe";
import type { Saga } from "../db/types.js";

export interface SellerSnapshot {
  accountId: string;
  legalName: string;
  country: string | null;
  bankFingerprint: string | null;
}

export interface Payments {
  getSeller(accountId: string): Promise<SellerSnapshot>;
  findTransfer(sagaId: string, destination: string): Promise<string | null>;
  createTransfer(input: {
    sagaId: string;
    amount: number;
    currency: string;
    destination: string;
    sourceTransaction: string | null;
    idempotencyKey: string;
  }): Promise<string>;
  reverseTransfer(transferId: string, idempotencyKey: string): Promise<void>;
}

/** What a reviewer approves. Any change to these fields voids the approval. */
export function payloadHash(saga: Pick<Saga, "amount" | "currency">, seller: SellerSnapshot) {
  const fields = [
    seller.accountId,
    seller.legalName,
    seller.bankFingerprint,
    saga.amount,
    saga.currency,
  ];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, 16);
}

export class StripePayments implements Payments {
  constructor(private readonly stripe: Stripe) {}

  async getSeller(accountId: string): Promise<SellerSnapshot> {
    const account = await this.stripe.accounts.retrieve(accountId);
    const bank = account.external_accounts?.data.find(
      (a): a is Stripe.BankAccount =>
        a.object === "bank_account" && a.default_for_currency === true,
    );
    return {
      accountId,
      legalName: account.company?.name ?? account.business_profile?.name ?? accountId,
      country: account.country ?? null,
      bankFingerprint: bank ? `${bank.fingerprint ?? bank.id}:${bank.last4}` : null,
    };
  }

  // Idempotency keys can expire after 24 hours, so look before writing.
  async findTransfer(sagaId: string, destination: string): Promise<string | null> {
    for await (const transfer of this.stripe.transfers.list({ destination, limit: 100 })) {
      if (transfer.metadata?.saga_id === sagaId) return transfer.id;
    }
    return null;
  }

  async createTransfer(input: Parameters<Payments["createTransfer"]>[0]): Promise<string> {
    const transfer = await this.stripe.transfers.create(
      {
        amount: input.amount,
        currency: input.currency,
        destination: input.destination,
        transfer_group: input.sagaId,
        ...(input.sourceTransaction ? { source_transaction: input.sourceTransaction } : {}),
        metadata: { saga_id: input.sagaId },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return transfer.id;
  }

  async reverseTransfer(transferId: string, idempotencyKey: string): Promise<void> {
    const transfer = await this.stripe.transfers.retrieve(transferId);
    if (transfer.reversed) return;
    await this.stripe.transfers.createReversal(transferId, {}, { idempotencyKey });
  }
}
