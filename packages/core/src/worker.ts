import type { Deps } from "./deps.js";
import type { QueueMessage } from "./messages.js";
import { onListChanged, onSellerChanged } from "./saga/compensation.js";
import { recordDecision } from "./saga/decisions.js";
import { completeReversal, completeTransfer, screen, startTransfer } from "./saga/steps.js";
import { syncSlack } from "./slack/sync.js";

/**
 * One consumer for every message. Each handler is an idempotent receiver: a
 * duplicate or late message finds the saga in another status and does nothing.
 */
export async function handleMessage(deps: Deps, message: QueueMessage, attempt: number) {
  switch (message.kind) {
    case "saga.advance": {
      const saga = await deps.db
        .selectFrom("sagas")
        .selectAll()
        .where("id", "=", message.sagaId)
        .executeTakeFirst();
      if (!saga || saga.status !== message.expect) {
        console.info("stale saga.advance ignored", { ...message, actual: saga?.status });
        return;
      }
      if (saga.status === "received") return screen(deps, saga, attempt);
      if (saga.status === "cleared" || saga.status === "approved") return startTransfer(deps, saga);
      if (saga.status === "transferring") return completeTransfer(deps, saga);
      if (saga.status === "reversing") return completeReversal(deps, saga);
      return;
    }
    case "slack.sync":
      return syncSlack(deps, message.sagaId);
    case "slack.decision":
      return recordDecision(deps, message);
    case "seller.changed":
      return onSellerChanged(deps, message.accountId);
    case "list.changed":
      return onListChanged(deps, message.added);
  }
}
