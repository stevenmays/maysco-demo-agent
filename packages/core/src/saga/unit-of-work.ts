import type { Transaction } from "kysely";
import type { Db } from "../db/client.js";
import type { Database } from "../db/types.js";
import type { Queue, QueueMessage } from "../messages.js";

export interface Tx {
  trx: Transaction<Database>;
  emit(sagaId: string | null, message: QueueMessage): Promise<void>;
}

/**
 * Transactional outbox. State changes and the messages they cause commit together;
 * the SQS send happens after commit. A Lambda that dies between the two leaves an
 * undispatched outbox row, and the sweeper sends it.
 */
export async function commit<T>(
  db: Db,
  queue: Queue,
  work: (tx: Tx) => Promise<T>,
  opts: { skipDispatch?: boolean } = {},
): Promise<T> {
  const ids: number[] = [];
  const result = await db.transaction().execute((trx) =>
    work({
      trx,
      async emit(sagaId, message) {
        const row = await trx
          .insertInto("outbox")
          .values({ saga_id: sagaId, message: JSON.stringify(message) })
          .returning("id")
          .executeTakeFirstOrThrow();
        ids.push(row.id);
      },
    }),
  );
  if (opts.skipDispatch) {
    console.warn("chaos: committed without dispatching", { outboxIds: ids });
    return result;
  }
  await dispatch(db, queue, ids, "commit").catch((error) =>
    console.error("dispatch failed after commit; the sweeper will resend", { ids, error }),
  );
  return result;
}

export async function dispatch(db: Db, queue: Queue, ids: number[], by: string): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .selectFrom("outbox")
    .select(["id", "message"])
    .where("id", "in", ids)
    .where("dispatched_at", "is", null)
    .orderBy("id")
    .execute();
  for (const row of rows) {
    await queue.send(row.message as QueueMessage);
    await db
      .updateTable("outbox")
      .set({ dispatched_at: new Date(), dispatched_by: by })
      .where("id", "=", row.id)
      .execute();
  }
  return rows.length;
}
