import { describe, expect, it } from "vitest";
import { decide } from "./policy.js";

const ok = (verdict: "no_match" | "possible_match" | "likely_match") => ({
  kind: "ok" as const,
  assessment: { verdict, matched_ent_num: null, reasons: [], summary: "" },
});

describe("decide", () => {
  it("needs two reviewers for a strong name match, whatever the model says", () => {
    expect(decide(0.97, ok("no_match"))).toMatchObject({ tier: "strong", requiredApprovals: 2 });
  });
  it("doesn't let the model clear a name in the review band", () => {
    expect(decide(0.91, ok("no_match"))).toMatchObject({ tier: "review", requiredApprovals: 1 });
  });
  it("lets the model add caution below the review band", () => {
    expect(decide(0.85, ok("possible_match")).tier).toBe("review");
    expect(decide(0.85, ok("no_match")).tier).toBe("clear");
  });
  it("sends a model failure to a person", () => {
    expect(decide(0.85, { kind: "failed", reason: "x" })).toMatchObject({
      tier: "review",
      reason: "The agent couldn't decide: x",
    });
  });
  it("clears low scores without a model call", () => {
    expect(decide(0.6, { kind: "skipped" }).tier).toBe("clear");
  });
});
