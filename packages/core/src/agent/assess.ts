import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { LeiRecord } from "../screening/gleif.js";
import type { Candidate } from "../screening/match.js";

export const MODEL = "claude-opus-5-5";
const INPUT_TOKEN_BUDGET = 6_000;
const MAX_OUTPUT_TOKENS = 8_000;
const REMARKS_LIMIT = 400;

export const AssessmentSchema = z.object({
  verdict: z.enum(["no_match", "possible_match", "likely_match"]),
  matched_ent_num: z.number().int().nullable(),
  reasons: z.array(z.string()).max(4),
  summary: z.string(),
});
export type Assessment = z.infer<typeof AssessmentSchema>;

export interface AssessInput {
  seller: { legalName: string; country: string | null; lei: LeiRecord | null };
  candidates: Candidate[];
  maxOutputTokens?: number;
}

export interface CallRecord {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
  outcome: string;
  latencyMs: number;
}

/**
 * Model I/O fails in ways regular code doesn't. `retryable` failures may pass on a
 * later attempt; the rest fail the same way every time, so they go to a person.
 */
export type AssessOutcome =
  | { kind: "ok"; assessment: Assessment; call: CallRecord }
  | { kind: "failed"; reason: string; retryable: boolean; call: CallRecord };

export interface Assessor {
  assess(input: AssessInput): Promise<AssessOutcome>;
}

const SYSTEM = `You help a sanctions compliance analyst at a US marketplace.
A seller's legal name scored close to one or more entities on the OFAC SDN list.
Decide whether the seller is plausibly the same organization as any candidate.
Weigh the full name, the country, the LEI record, and the program and remarks.
A shared common word is weak evidence. A matching distinctive name, alias, or country is strong evidence.
You don't make the final decision. A person reviews anything other than no_match.
Write the summary as one plain sentence for the reviewer.`;

function describe(input: AssessInput, candidateLimit: number): string {
  const { seller } = input;
  const lei = seller.lei
    ? `${seller.lei.legalName} (LEI ${seller.lei.lei}, ${seller.lei.country ?? "unknown country"}, ${seller.lei.status ?? "unknown status"})`
    : "No LEI record found";
  const candidates = input.candidates.slice(0, candidateLimit).map((c) => {
    const remarks = c.entity.remarks ?? "none";
    return {
      ent_num: c.entity.ent_num,
      sdn_name: c.entity.name,
      matched_name: c.matchedName,
      name_score: Number(c.score.toFixed(3)),
      program: c.entity.program,
      aliases: c.entity.aliases.slice(0, 5),
      remarks:
        remarks.length > REMARKS_LIMIT
          ? `${remarks.slice(0, REMARKS_LIMIT)} [remarks truncated at ${REMARKS_LIMIT} characters]`
          : remarks,
    };
  });
  return JSON.stringify(
    {
      seller: { legal_name: seller.legalName, country: seller.country, lei_record: lei },
      candidates,
    },
    null,
    2,
  );
}

export class ClaudeAssessor implements Assessor {
  constructor(private readonly client = new Anthropic({ maxRetries: 2 })) {}

  async assess(input: AssessInput): Promise<AssessOutcome> {
    const started = Date.now();
    const call = (partial: Partial<CallRecord> & { outcome: string }): CallRecord => ({
      model: MODEL,
      inputTokens: null,
      outputTokens: null,
      stopReason: null,
      latencyMs: Date.now() - started,
      ...partial,
    });

    try {
      const content = await this.fitToBudget(input);
      if (!content) {
        return {
          kind: "failed",
          reason: "the evidence is larger than the input budget",
          retryable: false,
          call: call({ outcome: "over_budget" }),
        };
      }
      const response = await this.client.messages.parse({
        model: MODEL,
        max_tokens: input.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
        system: SYSTEM,
        messages: [{ role: "user", content }],
        output_config: { effort: "low", format: zodOutputFormat(AssessmentSchema) },
      });
      const usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        stopReason: response.stop_reason,
      };
      // Check why the model stopped before reading what it said.
      if (response.stop_reason === "max_tokens") {
        return {
          kind: "failed",
          reason: "the model ran out of output tokens before it finished",
          retryable: false,
          call: call({ ...usage, outcome: "max_tokens" }),
        };
      }
      if (response.stop_reason === "refusal") {
        return {
          kind: "failed",
          reason: "the model declined to assess this seller",
          retryable: false,
          call: call({ ...usage, outcome: "refusal" }),
        };
      }
      const assessment = response.parsed_output;
      if (!assessment) {
        return {
          kind: "failed",
          reason: "the model's output didn't match the schema",
          retryable: false,
          call: call({ ...usage, outcome: "invalid_output" }),
        };
      }
      // A schema can't say "pick one of these ids", so code checks it.
      const known = new Set(input.candidates.map((c) => c.entity.ent_num));
      if (assessment.matched_ent_num !== null && !known.has(assessment.matched_ent_num)) {
        return {
          kind: "failed",
          reason: `the model cited entity ${assessment.matched_ent_num}, which isn't a candidate`,
          retryable: false,
          call: call({ ...usage, outcome: "invalid_reference" }),
        };
      }
      return { kind: "ok", assessment, call: call({ ...usage, outcome: "ok" }) };
    } catch (error) {
      if (
        error instanceof Anthropic.RateLimitError ||
        error instanceof Anthropic.InternalServerError ||
        error instanceof Anthropic.APIConnectionError
      ) {
        return {
          kind: "failed",
          reason: `the model API is unavailable (${error.constructor.name})`,
          retryable: true,
          call: call({ outcome: "unavailable" }),
        };
      }
      // Bad requests and auth errors are bugs or config, not model behavior: fail loudly.
      throw error;
    }
  }

  /** Measures the prompt and drops the weakest candidates until it fits. Never truncates silently. */
  private async fitToBudget(input: AssessInput): Promise<string | null> {
    for (let limit = input.candidates.length; limit >= 1; limit--) {
      const content = describe(input, limit);
      const { input_tokens } = await this.client.messages.countTokens({
        model: MODEL,
        system: SYSTEM,
        messages: [{ role: "user", content }],
      });
      if (input_tokens <= INPUT_TOKEN_BUDGET) return content;
    }
    return null;
  }
}
