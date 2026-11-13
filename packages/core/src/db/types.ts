import type { ColumnType, Generated, Insertable, Selectable } from "kysely";
import type { SagaStatus } from "../saga/states.js";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
// jsonb columns: read as parsed JSON, written as a JSON string.
type Json<T> = ColumnType<T, string | null, string | null>;

export interface SellersTable {
  stripe_account_id: string;
  legal_name: string | null;
  country: string | null;
  lei: string | null;
  updated_at: Timestamp;
}

export interface SagasTable {
  id: string;
  seller_account_id: string;
  payment_intent_id: string;
  charge_id: string | null;
  /** What the seller receives: the buyer's payment minus the platform commission. */
  amount: number;
  gross_amount: number | null;
  currency: string;
  status: SagaStatus;
  version: Generated<number>;
  payload_hash: string | null;
  required_approvals: Generated<number>;
  risk_tier: string | null;
  screening: Json<unknown | null>;
  transfer_id: string | null;
  slack_channel: string | null;
  slack_ts: string | null;
  chaos: string | null;
  remind_at: Date | null;
  reminded_at: Date | null;
  review_expires_at: Date | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SagaHistoryTable {
  id: Generated<number>;
  saga_id: string;
  from_status: SagaStatus | null;
  to_status: SagaStatus | null;
  actor: string;
  note: string;
  slack_posted_at: Date | null;
  created_at: Timestamp;
}

export interface OutboxTable {
  id: Generated<number>;
  saga_id: string | null;
  message: Json<unknown>;
  created_at: Timestamp;
  dispatched_at: Date | null;
  dispatched_by: string | null;
}

export interface InboxTable {
  source: string;
  event_id: string;
  received_at: Timestamp;
}

export interface ApprovalsTable {
  saga_id: string;
  reviewer: string;
  reviewer_name: string;
  decision: "approve" | "reject";
  payload_hash: string;
  reason: string | null;
  created_at: Timestamp;
}

export interface LedgerEntriesTable {
  id: Generated<number>;
  txn_id: string;
  saga_id: string;
  account: string;
  amount: number;
  memo: string;
  created_at: Timestamp;
}

export interface LlmCallsTable {
  id: Generated<number>;
  saga_id: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  stop_reason: string | null;
  outcome: string;
  latency_ms: number;
  created_at: Timestamp;
}

export interface SanctionsEntitiesTable {
  ent_num: number;
  name: string;
  program: string;
  remarks: string | null;
  aliases: ColumnType<string[], string, string>;
}

export interface SanctionsListVersionsTable {
  id: Generated<number>;
  content_hash: string;
  last_modified: string | null;
  entity_count: number;
  added_count: number;
  fetched_at: Timestamp;
}

export interface Database {
  sellers: SellersTable;
  sagas: SagasTable;
  saga_history: SagaHistoryTable;
  outbox: OutboxTable;
  inbox: InboxTable;
  approvals: ApprovalsTable;
  ledger_entries: LedgerEntriesTable;
  llm_calls: LlmCallsTable;
  sanctions_entities: SanctionsEntitiesTable;
  sanctions_list_versions: SanctionsListVersionsTable;
}

export type Saga = Selectable<SagasTable>;
export type NewSaga = Insertable<SagasTable>;
