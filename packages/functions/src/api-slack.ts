import { verifySlackSignature } from "@demo/core/slack/verify";
import { WebClient } from "@slack/web-api";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { queue } from "./lib/deps.js";

interface ButtonValue {
  sagaId: string;
  payloadHash: string;
}

/**
 * Slack waits 3 seconds for this response. The handler only checks the signature
 * and queues the click; the worker applies it against the database.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const raw = event.body ?? "";
  const body = event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
  const valid = verifySlackSignature(
    Resource.SlackSigningSecret.value,
    event.headers["x-slack-request-timestamp"] ?? "0",
    body,
    event.headers["x-slack-signature"] ?? "",
  );
  if (!valid) return { statusCode: 401, body: "invalid signature" };
  const payload = JSON.parse(new URLSearchParams(body).get("payload") ?? "{}");

  if (payload.type === "block_actions") {
    const action = payload.actions?.[0];
    const value = JSON.parse(action?.value ?? "{}") as ButtonValue;
    if (action?.action_id === "approve") {
      await queue.send({
        kind: "slack.decision",
        ...value,
        reviewer: payload.user.id,
        reviewerName: payload.user.name ?? payload.user.username ?? payload.user.id,
        decision: "approve",
        reason: null,
      });
    } else if (action?.action_id === "reject") {
      // trigger_id expires in 3 seconds, so the modal opens here, not in the worker.
      await new WebClient(Resource.SlackBotToken.value).views.open({
        trigger_id: payload.trigger_id,
        view: rejectModal(value),
      });
    }
    return { statusCode: 200, body: "" };
  }

  if (payload.type === "view_submission" && payload.view?.callback_id === "reject") {
    const value = JSON.parse(payload.view.private_metadata) as ButtonValue;
    await queue.send({
      kind: "slack.decision",
      ...value,
      reviewer: payload.user.id,
      reviewerName: payload.user.name ?? payload.user.username ?? payload.user.id,
      decision: "reject",
      reason: payload.view.state.values.reason.reason.value,
    });
    return { statusCode: 200, body: "" };
  }
  return { statusCode: 200, body: "" };
}

function rejectModal(value: ButtonValue) {
  return {
    type: "modal" as const,
    callback_id: "reject",
    private_metadata: JSON.stringify(value),
    title: { type: "plain_text" as const, text: "Reject and hold" },
    submit: { type: "plain_text" as const, text: "Hold funds" },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "reason",
        label: { type: "plain_text" as const, text: "Why are you holding this payout?" },
        element: { type: "plain_text_input", action_id: "reason", multiline: true },
      },
    ],
  };
}
