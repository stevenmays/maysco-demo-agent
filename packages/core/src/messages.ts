import type { SagaStatus } from "./saga/states.js";

export type QueueMessage =
  | { kind: "saga.advance"; sagaId: string; expect: SagaStatus }
  | { kind: "slack.sync"; sagaId: string }
  | {
      kind: "slack.decision";
      sagaId: string;
      payloadHash: string;
      reviewer: string;
      reviewerName: string;
      decision: "approve" | "reject";
      reason: string | null;
    }
  | { kind: "seller.changed"; accountId: string }
  | { kind: "list.changed"; added: number[] };

export interface Queue {
  send(message: QueueMessage): Promise<void>;
}
