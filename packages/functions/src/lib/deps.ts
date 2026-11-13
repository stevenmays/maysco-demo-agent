import Anthropic from "@anthropic-ai/sdk";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { ClaudeAssessor } from "@demo/core/agent/assess";
import { connect } from "@demo/core/db/client";
import type { Deps } from "@demo/core/deps";
import type { Queue, QueueMessage } from "@demo/core/messages";
import { findLei } from "@demo/core/screening/gleif";
import { SlackChat } from "@demo/core/slack/chat";
import { StripePayments } from "@demo/core/stripe/payments";
import { Resource } from "sst";
import Stripe from "stripe";

const sqs = new SQSClient({});

export const queue: Queue = {
  async send(message: QueueMessage) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: Resource.Steps.url,
        MessageBody: JSON.stringify(message),
      }),
    );
  },
};

export const stripe = () => new Stripe(Resource.StripeSecretKey.value);
export const db = () => connect(Resource.DatabaseUrl.value);

let deps: Deps | null = null;

export function getDeps(): Deps {
  deps ??= {
    db: db(),
    queue,
    payments: new StripePayments(stripe()),
    assessor: new ClaudeAssessor(
      new Anthropic({ apiKey: Resource.AnthropicApiKey.value, maxRetries: 2 }),
    ),
    chat: new SlackChat(Resource.SlackBotToken.value),
    findLei: (name) => findLei(name),
    config: {
      slackChannel: Resource.SlackChannelId.value,
      remindAfterMinutes: Number(process.env.REMIND_AFTER_MINUTES ?? 240),
      reviewTtlMinutes: Number(process.env.REVIEW_TTL_MINUTES ?? 1440),
    },
  };
  return deps;
}
