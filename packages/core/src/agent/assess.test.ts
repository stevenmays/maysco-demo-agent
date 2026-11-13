import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ENTITIES } from "../test-utils.js";
import { type AssessInput, ClaudeAssessor } from "./assess.js";

const input: AssessInput = {
  seller: { legalName: "Quillmark Traders LLC", country: "US", lei: null },
  candidates: [{ entity: ENTITIES[0]!, matchedName: "QUILLMARK TRADING HOUSE", score: 0.84 }],
};

function fakeClient(response: unknown, inputTokens = 500) {
  return {
    messages: {
      countTokens: async () => ({ input_tokens: inputTokens }),
      create: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
    },
  } as unknown as Anthropic;
}

const usage = { input_tokens: 500, output_tokens: 80 };
const reply = (stop_reason: string, text: string) => ({
  stop_reason,
  usage,
  content: [{ type: "text", text }],
});
const assessment = {
  verdict: "possible_match",
  matched_ent_num: 990_001,
  reasons: ["Shares the distinctive token QUILLMARK"],
  summary: "Possibly related to the listed Quillmark Trading House.",
};

describe("ClaudeAssessor", () => {
  it("returns a validated assessment", async () => {
    const out = await new ClaudeAssessor(
      fakeClient(reply("end_turn", JSON.stringify(assessment))),
    ).assess(input);
    expect(out.kind).toBe("ok");
  });

  it.each([
    ["max_tokens", reply("max_tokens", '{"verdict": "possible_')],
    ["refusal", reply("refusal", "")],
    ["invalid_output", reply("end_turn", "The seller looks like a possible match.")],
    ["invalid_output", reply("end_turn", JSON.stringify({ ...assessment, verdict: "maybe" }))],
    [
      "invalid_reference",
      reply("end_turn", JSON.stringify({ ...assessment, matched_ent_num: 4242 })),
    ],
  ])("treats %s as a failure that retrying won't fix", async (outcome, response) => {
    const out = await new ClaudeAssessor(fakeClient(response)).assess(input);
    expect(out).toMatchObject({
      kind: "failed",
      retryable: false,
      call: { outcome },
    });
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
