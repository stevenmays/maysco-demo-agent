import type { Updateable } from "kysely";
import type { Saga, SagasTable } from "../db/types.js";
import { canTransition, type SagaStatus } from "./states.js";
import type { Tx } from "./unit-of-work.js";

export interface TransitionOpts {
  actor: string;
  note: string;
  patch?: Omit<Updateable<SagasTable>, "status" | "version" | "id">;
}

/**
 * Moves a saga only if nobody else moved it first: the update matches on the status
 * and version this caller read. Returns false when it lost that race, so the caller
 * drops its result instead of overwriting newer state.
 */
export async function transition(
  tx: Tx,
  saga: Saga,
  to: SagaStatus,
  opts: TransitionOpts,
): Promise<boolean> {
  if (!canTransition(saga.status, to)) {
    throw new Error(`Illegal saga transition ${saga.status} -> ${to} (${saga.id})`);
  }
  const result = await tx.trx
    .updateTable("sagas")
    .set({ ...opts.patch, status: to, version: saga.version + 1, updated_at: new Date() })
    .where("id", "=", saga.id)
    .where("status", "=", saga.status)
    .where("version", "=", saga.version)
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) return false;
  await record(tx, saga.id, { from: saga.status, to, actor: opts.actor, note: opts.note });
  return true;
}

export async function record(
  tx: Tx,
  sagaId: string,
  entry: { from?: SagaStatus; to?: SagaStatus; actor: string; note: string },
): Promise<void> {
  await tx.trx
    .insertInto("saga_history")
    .values({
      saga_id: sagaId,
      from_status: entry.from ?? null,
      to_status: entry.to ?? null,
      actor: entry.actor,
      note: entry.note,
    })
    .execute();
  await tx.emit(sagaId, { kind: "slack.sync", sagaId });
}

export async function advance(tx: Tx, sagaId: string, expect: SagaStatus): Promise<void> {
  await tx.emit(sagaId, { kind: "saga.advance", sagaId, expect });
}
