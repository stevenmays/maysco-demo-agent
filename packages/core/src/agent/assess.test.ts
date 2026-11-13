import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ENTITIES } from "../test-utils.js";
import { type AssessInput, ClaudeAssessor } from "./assess.js";

const input: AssessInput = {
  seller: { legalName: "Cimex Logistics Ltd", country: "US", lei: null },
  candidates: [{ entity: ENTITIES[1]!, matchedName: "CIMEX", score: 0.86 }],
};

function fakeClient(response: unknown, inputTokens = 500) {
  return {
    messages: {
      countTokens: async () => ({ input_tokens: inputTokens }),
      parse: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
    },
  } as unknown as Anthropic;
}

const usage = { input_tokens: 500, output_tokens: 80 };
const assessment = {
  verdict: "possible_match",
  matched_ent_num: 559,
  reasons: ["Shares the distinctive token CIMEX"],
  summary: "Possibly related to the Cuban conglomerate CIMEX.",
};

describe("ClaudeAssessor", () => {
  it("returns a validated assessment", async () => {
    const out = await new ClaudeAssessor(
      fakeClient({ stop_reason: "end_turn", usage, parsed_output: assessment }),
    ).assess(input);
    expect(out.kind).toBe("ok");
  });

  it.each([
    ["max_tokens", { stop_reason: "max_tokens", usage, parsed_output: null }],
    ["refusal", { stop_reason: "refusal", usage, parsed_output: null }],
    ["invalid_output", { stop_reason: "end_turn", usage, parsed_output: null }],
    [
      "invalid_reference",
      { stop_reason: "end_turn", usage, parsed_output: { ...assessment, matched_ent_num: 4242 } },
    ],
  ])("treats %s as a failure that retrying won't fix", async (outcome, response) => {
    const out = await new ClaudeAssessor(fakeClient(response)).assess(input);
    expect(out).toMatchObject({ kind: "failed", retryable: false, call: { outcome } });
  });

  it("marks an overloaded API as retryable", async () => {
    const error = new Anthropic.RateLimitError(429, undefined, "rate limited", new Headers());
    const out = await new ClaudeAssessor(fakeClient(error)).assess(input);
    expect(out).toMatchObject({ kind: "failed", retryable: true });
  });

  it("refuses evidence that doesn't fit the input budget", async () => {
    const out = await new ClaudeAssessor(fakeClient({}, 50_000)).assess(input);
    expect(out).toMatchObject({
      kind: "failed",
      retryable: false,
      call: { outcome: "over_budget" },
    });
  });

  it("rethrows bad requests, which are bugs, not model behavior", async () => {
    const error = new Anthropic.BadRequestError(400, undefined, "bad", new Headers());
    await expect(new ClaudeAssessor(fakeClient(error)).assess(input)).rejects.toBe(error);
  });
});
