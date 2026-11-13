import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Saga } from "../db/types.js";
import { renderCard } from "./card.js";
import { verifySlackSignature } from "./verify.js";

describe("verifySlackSignature", () => {
  const secret = "test-secret";
  const sign = (ts: string, body: string) =>
    `v0=${crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;

  it("accepts a fresh, correctly signed request", () => {
    expect(verifySlackSignature(secret, "1000", "a=b", sign("1000", "a=b"), 1100)).toBe(true);
  });
  it("rejects a tampered body and a replayed timestamp", () => {
    expect(verifySlackSignature(secret, "1000", "a=c", sign("1000", "a=b"), 1100)).toBe(false);
    expect(verifySlackSignature(secret, "1000", "a=b", sign("1000", "a=b"), 2000)).toBe(false);
  });
});

describe("renderCard", () => {
  const saga = {
    id: "s1",
    amount: 12_500,
    currency: "usd",
    status: "awaiting_review",
    seller_account_id: "acct_1",
    payload_hash: "h1",
    required_approvals: 2,
    review_expires_at: null,
    screening: null,
  } as unknown as Saga;

  it("shows buttons only while a review is open", () => {
    expect(JSON.stringify(renderCard(saga, []).blocks)).toContain("Approve payout");
    expect(JSON.stringify(renderCard({ ...saga, status: "paid" }, []).blocks)).not.toContain(
      "Approve payout",
    );
  });
  it("shows approval progress for a two-reviewer payout", () => {
    const card = renderCard(saga, [{ reviewer: "U1", reviewer_name: "Ana" }]);
    expect(JSON.stringify(card.blocks)).toContain("1 of 2 approved (Ana)");
  });
});
