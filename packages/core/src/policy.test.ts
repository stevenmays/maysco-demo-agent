import { describe, expect, it } from "vitest";
import { AGENT_CLEAR_LIMIT, decide } from "./policy.js";

const ok = (
  verdict: "no_match" | "possible_match" | "likely_match",
  confidence: "low" | "medium" | "high" = "high",
) => ({
  kind: "ok" as const,
  assessment: { verdict, confidence, matched_ent_num: null, reasons: [], summary: "" },
});
const small = 11_250;

describe("decide", () => {
  it("clears low scores in code, without a model call", () => {
    expect(decide(0.6, { kind: "skipped" }, small).tier).toBe("clear");
  });
  it("lets the agent clear a gray-zone name it is confident about", () => {
    expect(decide(0.85, ok("no_match"), small)).toMatchObject({
      tier: "agent_clear",
      requiredApprovals: 0,
    });
  });
  it("sends the agent's less-than-high confidence to a person", () => {
    expect(decide(0.85, ok("no_match", "medium"), small).tier).toBe("review");
  });
  it("caps what the agent may release on its own", () => {
    expect(decide(0.85, ok("no_match"), AGENT_CLEAR_LIMIT + 1).tier).toBe("review");
  });
  it("sends any flagged match to a person", () => {
    expect(decide(0.85, ok("possible_match"), small).tier).toBe("review");
  });
  it("doesn't let the agent clear a name in the review band", () => {
    expect(decide(0.91, ok("no_match"), small)).toMatchObject({
      tier: "review",
      requiredApprovals: 1,
    });
  });
  it("needs two reviewers for a strong name match, whatever the model says", () => {
    expect(decide(0.97, ok("no_match"), small)).toMatchObject({
      tier: "strong",
      requiredApprovals: 2,
    });
  });
  it("sends a model failure to a person", () => {
    expect(decide(0.85, { kind: "failed", reason: "x" }, small)).toMatchObject({
      tier: "review",
      reason: "The agent couldn't decide: x",
    });
  });
});
