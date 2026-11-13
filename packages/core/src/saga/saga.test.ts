import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncSlack } from "../slack/sync.js";
import { drain, ledgerTotals, makeDeps, okPossible, type TestDeps } from "../test-utils.js";
import { handleMessage } from "../worker.js";
import { onListChanged, onSellerChanged } from "./compensation.js";
import { recordDecision } from "./decisions.js";
import { startSaga } from "./intake.js";
import { RetryLater } from "./steps.js";
import { sweep } from "./sweeper.js";

let deps: TestDeps;
beforeEach(async () => {
  deps = await makeDeps();
});
afterEach(async () => {
  await deps.db.destroy();
});

let n = 0;
async function pay(account: string, opts: { chaos?: string; eventId?: string } = {}) {
  n++;
  return startSaga(deps.db, deps.queue, {
    eventId: opts.eventId ?? `evt_${n}`,
    paymentIntentId: `pi_${n}`,
    chargeId: `ch_${n}`,
    sellerAccountId: account,
    amount: 12_500,
    currency: "usd",
    chaos: opts.chaos ?? null,
  });
}

const saga = () => deps.db.selectFrom("sagas").selectAll().executeTakeFirstOrThrow();

function click(
  s: { id: string; payload_hash: string | null },
  reviewer: string,
  decision: "approve" | "reject" = "approve",
) {
  return recordDecision(deps, {
    kind: "slack.decision",
    sagaId: s.id,
    payloadHash: s.payload_hash!,
    reviewer,
    reviewerName: reviewer.toUpperCase(),
    decision,
    reason: decision === "reject" ? "Same address as the SDN entry" : null,
  });
}

async function expectBalancedLedger() {
  const { byTxn } = await ledgerTotals(deps.db);
  for (const [txn, sum] of byTxn) expect(sum, txn).toBe(0);
}

describe("payout saga", () => {
  it("clears and pays a seller with no close match, without calling the model", async () => {
    deps.payments.addSeller("acct_clean", "Maple Ridge Ceramics LLC");
    await pay("acct_clean");
    await drain(deps);

    const s = await saga();
    expect(s.status).toBe("paid");
    expect(deps.assessor.calls).toHaveLength(0);
    expect(deps.payments.creates).toBe(1);
    expect(deps.chat.posts).toHaveLength(1);
    await expectBalancedLedger();
  });

  it("ignores a redelivered webhook", async () => {
    deps.payments.addSeller("acct_clean", "Maple Ridge Ceramics LLC");
    expect(await pay("acct_clean", { eventId: "evt_dup" })).toBe("started");
    expect(await pay("acct_clean", { eventId: "evt_dup" })).toBe("duplicate");
    const count = await deps.db
      .selectFrom("sagas")
      .select(sql<number>`count(*)::int`.as("n"))
      .executeTakeFirstOrThrow();
    expect(count.n).toBe(1);
  });

  it("sends a near miss to one reviewer and pays after approval", async () => {
    deps.payments.addSeller("acct_near", "Cimex Logistics Ltd");
    deps.assessor.next = okPossible;
    await pay("acct_near");
    await drain(deps);

    let s = await saga();
    expect(s.status).toBe("awaiting_review");
    expect(s.required_approvals).toBe(1);
    const card = deps.chat.updates.at(-1)!.message;
    expect(JSON.stringify(card.blocks)).toContain("Approve payout");

    await click(s, "U_ANA");
    await drain(deps);
    s = await saga();
    expect(s.status).toBe("paid");
    await expectBalancedLedger();
  });

  it("applies one decision when the same review gets two approvals", async () => {
    deps.payments.addSeller("acct_near", "Cimex Logistics Ltd");
    deps.assessor.next = okPossible;
    await pay("acct_near");
    await drain(deps);
    const s = await saga();

    // In-process Postgres has one connection, so these run one after the other.
    // The concurrent version of this test needs a real database.
    await click(s, "U_ANA");
    await click(s, "U_BEN");
    await drain(deps);

    expect((await saga()).status).toBe("paid");
    expect(deps.payments.creates).toBe(1);
    expect(deps.chat.ephemerals).toEqual([
      {
        user: "U_BEN",
        text: expect.stringContaining("This review is closed. It was approved by U_ANA"),
      },
    ]);
  });

  it("requires two different reviewers for a strong match", async () => {
    deps.payments.addSeller("acct_strong", "Aero Caribbean Airlines Inc");
    await pay("acct_strong");
    await drain(deps);
    let s = await saga();
    expect(s.status).toBe("awaiting_review");
    expect(s.required_approvals).toBe(2);
    expect(deps.assessor.calls).toHaveLength(0);

    await click(s, "U_ANA");
    await click(s, "U_ANA");
    expect((await saga()).status).toBe("awaiting_review");
    expect(deps.chat.ephemerals[0]!.text).toContain("different reviewer");

    await click(s, "U_BEN");
    await drain(deps);
    s = await saga();
    expect(s.status).toBe("paid");
  });

  it("voids approvals when bank details change, and refuses clicks on the old card", async () => {
    deps.payments.addSeller("acct_strong", "Aero Caribbean Airlines Inc");
    await pay("acct_strong");
    await drain(deps);
    const before = await saga();
    await click(before, "U_ANA");

    deps.payments.addSeller("acct_strong", "Aero Caribbean Airlines Inc", "fp_2:4321");
    await onSellerChanged(deps, "acct_strong");
    await drain(deps);

    const after = await saga();
    expect(after.status).toBe("awaiting_review");
    expect(after.payload_hash).not.toBe(before.payload_hash);

    await click(before, "U_BEN");
    expect(deps.chat.ephemerals.at(-1)!.text).toContain("out of date");
    await click(after, "U_BEN");
    expect((await saga()).status).toBe("awaiting_review");
  });

  it("re-screens instead of paying when details change between approval and transfer", async () => {
    deps.payments.addSeller("acct_near", "Cimex Logistics Ltd");
    deps.assessor.next = okPossible;
    await pay("acct_near");
    await drain(deps);
    await click(await saga(), "U_ANA");
    deps.payments.addSeller("acct_near", "Cimex Logistics Ltd", "fp_9:0000");
    await drain(deps);

    expect((await saga()).status).toBe("awaiting_review");
    expect(deps.payments.creates).toBe(0);
  });

  it("holds funds when a reviewer rejects", async () => {
    deps.payments.addSeller("acct_near", "Cimex Logistics Ltd");
    deps.assessor.next = okPossible;
    await pay("acct_near");
    await drain(deps);
    await click(await saga(), "U_ANA", "reject");
    await drain(deps);

    expect((await saga()).status).toBe("held");
    const { byAccount } = await ledgerTotals(deps.db);
    expect(byAccount.get("held_payable:acct_near")).toBe(-12_500);
    await expectBalancedLedger();
  });

  it("does not create a second transfer when Stripe already has one", async () => {
    deps.payments.addSeller("acct_clean", "Maple Ridge Ceramics LLC");
    await pay("acct_clean");
    const s = await saga();
    deps.payments.transfers.set(s.id, { id: "tr_existing", idempotencyKey: "x" });
    await drain(deps);

    expect((await saga()).transfer_id).toBe("tr_existing");
    expect(deps.payments.creates).toBe(0);
  });
});

describe("outbox and sweeper", () => {
  it("recovers a message committed but never sent", async () => {
    deps.payments.addSeller("acct_clean", "Maple Ridge Ceramics LLC");
    await pay("acct_clean", { chaos: "skip_dispatch" });
    expect(deps.queue.messages).toHaveLength(0);

    expect((await sweep(deps)).resent).toBe(0);
    await deps.db
      .updateTable("outbox")
      .set({ created_at: sql`now() - interval '90 seconds'` })
      .execute();
    const result = await sweep(deps);
    expect(result.resent).toBeGreaterThanOrEqual(1);
    await drain(deps);

    expect((await saga()).status).toBe("paid");
    expect(deps.chat.replies.some((r) => r.includes("never sent"))).toBe(true);
  });

  it("reminds once, then expires an unanswered review and holds funds", async () => {
    deps.payments.addSeller("acct_near", "Cimex Logistics Ltd");
    deps.assessor.next = okPossible;
    await pay("acct_near");
    await drain(deps);

    await deps.db
      .updateTable("sagas")
      .set({ remind_at: sql`now() - interval '1 minute'` })
      .execute();
    expect((await sweep(deps)).reminded).toBe(1);
    expect((await sweep(deps)).reminded).toBe(0);

    await deps.db
      .updateTable("sagas")
      .set({ review_expires_at: sql`now() - interval '1 minute'` })
      .execute();
    expect((await sweep(deps)).expired).toBe(1);
    expect((await saga()).status).toBe("held");
    await expectBalancedLedger();
  });
});

describe("model failures", () => {
  const failed = (retryable: boolean) => () => ({
    kind: "failed" as const,
    reason: "the model ran out of output tokens before it finished",
    retryable,
    call: {
      model: "fake",
      inputTokens: 1,
      outputTokens: 64,
      stopReason: "max_tokens",
      latencyMs: 1,
      outcome: "max_tokens",
    },
  });

  it("sends a seller to a person when the model output is unusable", async () => {
    deps.payments.addSeller("acct_near", "Cimex Logistics Ltd");
    deps.assessor.next = failed(false);
    await pay("acct_near");
    await drain(deps);

    const s = await saga();
    expect(s.status).toBe("awaiting_review");
    expect(JSON.stringify(s.screening)).toContain("The agent couldn't decide");
    const calls = await deps.db.selectFrom("llm_calls").selectAll().execute();
    expect(calls[0]!.outcome).toBe("max_tokens");
  });

  it("retries an unavailable model, then falls back to a person", async () => {
    deps.payments.addSeller("acct_near", "Cimex Logistics Ltd");
    deps.assessor.next = failed(true);
    await pay("acct_near");
    const message = deps.queue.messages.find((m) => m.kind === "saga.advance")!;

    await expect(handleMessage(deps, message, 1)).rejects.toBeInstanceOf(RetryLater);
    await handleMessage(deps, message, 3);
    expect((await saga()).status).toBe("awaiting_review");
  });

  it("lets a code bug fail loudly instead of guessing", async () => {
    deps.payments.addSeller("acct_near", "Cimex Logistics Ltd");
    deps.assessor.next = () => {
      throw new TypeError("bug");
    };
    await pay("acct_near");
    await expect(drain(deps)).rejects.toThrow("bug");
    expect((await saga()).status).toBe("received");
  });
});

describe("sanctions list changes", () => {
  it("reverses a paid transfer when a new entry matches the seller", async () => {
    deps.payments.addSeller("acct_clean", "Harbor Lantern Imports");
    await pay("acct_clean");
    await drain(deps);
    expect((await saga()).status).toBe("paid");

    await deps.db
      .insertInto("sanctions_entities")
      .values({
        ent_num: 99_001,
        name: "HARBOR LANTERN IMPORTS LIMITED",
        program: "DEMO",
        remarks: null,
        aliases: "[]",
      })
      .execute();
    await onListChanged(deps, [99_001]);
    await drain(deps);

    const s = await saga();
    expect(s.status).toBe("held");
    expect(deps.payments.reversed).toEqual([s.transfer_id]);
    await expectBalancedLedger();
  });
});

describe("slack sync", () => {
  it("posts one card when several workers sync the same saga at once", async () => {
    deps.payments.addSeller("acct_clean", "Brindlecove Ceramics LLC");
    await pay("acct_clean");
    const s = await saga();
    await Promise.all([syncSlack(deps, s.id), syncSlack(deps, s.id), syncSlack(deps, s.id)]);

    expect(deps.chat.posts).toHaveLength(1);
    expect(deps.chat.replies).toHaveLength(1);
  });
});
