import type { Assessment } from "./agent/assess.js";

export type AssessmentResult =
  | { kind: "skipped" }
  | { kind: "ok"; assessment: Assessment }
  | { kind: "failed"; reason: string };

/**
 * Three tiers of decision-maker:
 * - `clear`: code clears it. No model call, no person.
 * - `agent_clear`: the model clears it inside limits code enforces. People see a log, not a button.
 * - `review` / `strong`: 1 or 2 people must approve.
 */
export type Tier = "clear" | "agent_clear" | "review" | "strong";

export interface Decision {
  tier: Tier;
  requiredApprovals: 0 | 1 | 2;
  reason: string;
}

// Calibrated against the full SDN entity list: unrelated names score up to about 0.81.
export const THRESHOLDS = {
  strong: 0.95,
  review: 0.9,
  askModel: 0.82,
} as const;

/** The most the agent may release without a person, in the smallest currency unit. */
export const AGENT_CLEAR_LIMIT = 50_000;

/**
 * Policy is code, not a prompt. The name score sets a floor the model can't lower.
 * Inside the gray zone the model may clear a payout, but only when it is confident
 * and the amount is small. Everything else, including any model failure, reaches a person.
 */
export function decide(topScore: number, result: AssessmentResult, amount: number): Decision {
  const score = topScore.toFixed(2);
  const review = (reason: string): Decision => ({
    tier: "review",
    requiredApprovals: 1,
    reason,
  });

  if (topScore >= THRESHOLDS.strong) {
    return {
      tier: "strong",
      requiredApprovals: 2,
      reason: `Name score ${score} is a strong match`,
    };
  }
  if (result.kind === "failed") return review(`The agent couldn't decide: ${result.reason}`);
  if (topScore >= THRESHOLDS.review) return review(`Name score ${score} needs a reviewer`);
  if (result.kind === "skipped") {
    return {
      tier: "clear",
      requiredApprovals: 0,
      reason: `Top name score ${score} is below review`,
    };
  }

  const { verdict, confidence } = result.assessment;
  if (verdict !== "no_match") return review(`The agent flagged a ${verdict.replace("_", " ")}`);
  if (confidence !== "high")
    return review(`The agent saw no match, but only with ${confidence} confidence`);
  if (amount > AGENT_CLEAR_LIMIT) {
    return review(
      `The agent saw no match, but the amount is over its $${AGENT_CLEAR_LIMIT / 100} limit`,
    );
  }
  return {
    tier: "agent_clear",
    requiredApprovals: 0,
    reason: `The agent cleared it: no match, high confidence, within its $${AGENT_CLEAR_LIMIT / 100} limit`,
  };
}
