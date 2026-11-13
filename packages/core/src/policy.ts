import type { Assessment } from "./agent/assess.js";

export type AssessmentResult =
  | { kind: "skipped" }
  | { kind: "ok"; assessment: Assessment }
  | { kind: "failed"; reason: string };

export type Tier = "clear" | "review" | "strong";

export interface Decision {
  tier: Tier;
  requiredApprovals: 0 | 1 | 2;
  reason: string;
}

// Calibrated against the full SDN entity list: unrelated names score up to about 0.81.
export const THRESHOLDS = { strong: 0.95, review: 0.9, askModel: 0.82 } as const;

/**
 * Policy is code, not a prompt. The name score sets a floor the model can't lower;
 * the model can only add caution, and a model failure always reaches a person.
 */
export function decide(topScore: number, result: AssessmentResult): Decision {
  const score = topScore.toFixed(2);
  if (topScore >= THRESHOLDS.strong) {
    return {
      tier: "strong",
      requiredApprovals: 2,
      reason: `Name score ${score} is a strong match`,
    };
  }
  if (result.kind === "failed") {
    return {
      tier: "review",
      requiredApprovals: 1,
      reason: `The agent couldn't decide: ${result.reason}`,
    };
  }
  if (topScore >= THRESHOLDS.review) {
    return { tier: "review", requiredApprovals: 1, reason: `Name score ${score} needs a reviewer` };
  }
  if (result.kind === "ok" && result.assessment.verdict !== "no_match") {
    return {
      tier: "review",
      requiredApprovals: 1,
      reason: `The agent flagged a ${result.assessment.verdict.replace("_", " ")}`,
    };
  }
  return { tier: "clear", requiredApprovals: 0, reason: `Top name score ${score} is below review` };
}
