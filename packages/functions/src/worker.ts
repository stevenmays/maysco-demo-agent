import type { QueueMessage } from "@demo/core/messages";
import { handleMessage } from "@demo/core/worker";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { getDeps } from "./lib/deps.js";

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: SQSBatchResponse["batchItemFailures"] = [];
  for (const record of event.Records) {
    const message = JSON.parse(record.body) as QueueMessage;
    const attempt = Number(record.attributes.ApproximateReceiveCount);
    try {
      await handleMessage(getDeps(), message, attempt);
    } catch (error) {
      // SQS redelivers after the visibility timeout; after 5 receives it goes to the DLQ.
      console.error("message failed", { message, attempt, error });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
