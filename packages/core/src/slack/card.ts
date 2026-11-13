import type { Saga } from "../db/types.js";
import type { Decision } from "../policy.js";
import type { Message } from "./chat.js";

export interface Screening {
  seller: { legalName: string; country: string | null };
  lei: { lei: string; legalName: string; country: string | null } | null;
  candidates: Array<{ name: string; matchedName: string; program: string; score: number }>;
  assessment: { verdict: string; summary: string; reasons: string[] } | null;
  decision: Decision;
}

export interface ApprovalView {
  reviewer: string;
  reviewer_name: string;
}

const money = (s: Saga) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: s.currency }).format(
    s.amount / 100,
  );

const STATUS_LINE: Record<Saga["status"], string> = {
  received: ":hourglass_flowing_sand: Screening",
  awaiting_review: ":raised_hand: Waiting for review",
  cleared: ":white_check_mark: Cleared automatically",
  approved: ":white_check_mark: Approved",
  transferring: ":arrows_counterclockwise: Sending transfer",
  paid: ":moneybag: Paid",
  reversing: ":rewind: Reversing transfer",
  held: ":lock: Funds held",
};

export function renderCard(saga: Saga, approvals: ApprovalView[]): Message {
  const screening = saga.screening as Screening | null;
  const name = screening?.seller.legalName ?? saga.seller_account_id;
  const text = `Payout ${money(saga)} to ${name}: ${STATUS_LINE[saga.status]}`;
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `Payout to ${name}` } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Amount*\n${money(saga)}` },
        { type: "mrkdwn", text: `*Status*\n${STATUS_LINE[saga.status]}` },
        { type: "mrkdwn", text: `*Seller country*\n${screening?.seller.country ?? "unknown"}` },
        {
          type: "mrkdwn",
          text: `*LEI record*\n${screening?.lei ? `${screening.lei.legalName} (${screening.lei.country ?? "?"})` : "none found"}`,
        },
      ],
    },
  ];

  if (screening) {
    const top = screening.candidates[0];
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: top
          ? `*Closest SDN entry*\n${top.name}${top.matchedName !== top.name ? ` (alias "${top.matchedName}")` : ""} · [${top.program}] · name score *${top.score.toFixed(2)}*`
          : "*Closest SDN entry*\nnone",
      },
    });
    if (screening.assessment) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Agent: ${screening.assessment.verdict.replace("_", " ")}*\n${screening.assessment.summary}\n${screening.assessment.reasons.map((r) => `• ${r}`).join("\n")}`,
        },
      });
    }
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `*Policy:* ${screening.decision.reason}` }],
    });
  }

  if (saga.status === "awaiting_review") {
    const needed = saga.required_approvals;
    const names = approvals.map((a) => a.reviewer_name).join(", ");
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${needed > 1 ? `Needs ${needed} different reviewers` : "Needs 1 reviewer"} · ${approvals.length} of ${needed} approved${names ? ` (${names})` : ""}${saga.review_expires_at ? ` · expires <!date^${Math.floor(new Date(saga.review_expires_at).getTime() / 1000)}^{time}|soon>` : ""}`,
        },
      ],
    });
    const value = JSON.stringify({ sagaId: saga.id, payloadHash: saga.payload_hash });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "approve",
          style: "primary",
          text: { type: "plain_text", text: "Approve payout" },
          value,
        },
        {
          type: "button",
          action_id: "reject",
          style: "danger",
          text: { type: "plain_text", text: "Reject and hold" },
          value,
        },
      ],
    });
  }
  return { text, blocks };
}
