import { type Kysely, sql } from "kysely";

// Migrations take an untyped db so they never depend on today's schema types.
// biome-ignore lint/suspicious/noExplicitAny: Kysely's documented migration signature
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("sellers")
    .addColumn("stripe_account_id", "text", (c) => c.primaryKey())
    .addColumn("legal_name", "text")
    .addColumn("country", "text")
    .addColumn("lei", "text")
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("sagas")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("seller_account_id", "text", (c) => c.notNull())
    .addColumn("payment_intent_id", "text", (c) => c.notNull().unique())
    .addColumn("charge_id", "text")
    .addColumn("amount", "integer", (c) => c.notNull())
    .addColumn("currency", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("payload_hash", "text")
    .addColumn("required_approvals", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("risk_tier", "text")
    .addColumn("screening", "jsonb")
    .addColumn("transfer_id", "text")
    .addColumn("slack_channel", "text")
    .addColumn("slack_ts", "text")
    .addColumn("chaos", "text")
    .addColumn("remind_at", "timestamptz")
    .addColumn("reminded_at", "timestamptz")
    .addColumn("review_expires_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex("sagas_status_idx").on("sagas").column("status").execute();
  await db.schema.createIndex("sagas_seller_idx").on("sagas").column("seller_account_id").execute();

  await db.schema
    .createTable("saga_history")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("saga_id", "text", (c) => c.notNull().references("sagas.id"))
    .addColumn("from_status", "text")
    .addColumn("to_status", "text")
    .addColumn("actor", "text", (c) => c.notNull())
    .addColumn("note", "text", (c) => c.notNull())
    .addColumn("slack_posted_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .createIndex("saga_history_saga_idx")
    .on("saga_history")
    .column("saga_id")
    .execute();

  await db.schema
    .createTable("outbox")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("saga_id", "text")
    .addColumn("message", "jsonb", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("dispatched_at", "timestamptz")
    .addColumn("dispatched_by", "text")
    .execute();
  await db.schema
    .createIndex("outbox_pending_idx")
    .on("outbox")
    .column("created_at")
    .where(sql.ref("dispatched_at"), "is", null)
    .execute();

  await db.schema
    .createTable("inbox")
    .addColumn("source", "text", (c) => c.notNull())
    .addColumn("event_id", "text", (c) => c.notNull())
    .addColumn("received_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("inbox_pk", ["source", "event_id"])
    .execute();

  await db.schema
    .createTable("approvals")
    .addColumn("saga_id", "text", (c) => c.notNull().references("sagas.id"))
    .addColumn("reviewer", "text", (c) => c.notNull())
    .addColumn("reviewer_name", "text", (c) => c.notNull())
    .addColumn("decision", "text", (c) => c.notNull())
    .addColumn("payload_hash", "text", (c) => c.notNull())
    .addColumn("reason", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("approvals_pk", ["saga_id", "reviewer", "payload_hash"])
    .execute();

  await db.schema
    .createTable("ledger_entries")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("txn_id", "text", (c) => c.notNull())
    .addColumn("saga_id", "text", (c) => c.notNull())
    .addColumn("account", "text", (c) => c.notNull())
    .addColumn("amount", "integer", (c) => c.notNull())
    .addColumn("memo", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("ledger_txn_account_uq", ["txn_id", "account"])
    .execute();

  await db.schema
    .createTable("llm_calls")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("saga_id", "text", (c) => c.notNull())
    .addColumn("model", "text", (c) => c.notNull())
    .addColumn("input_tokens", "integer")
    .addColumn("output_tokens", "integer")
    .addColumn("stop_reason", "text")
    .addColumn("outcome", "text", (c) => c.notNull())
    .addColumn("latency_ms", "integer", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("sanctions_entities")
    .addColumn("ent_num", "integer", (c) => c.primaryKey())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("program", "text", (c) => c.notNull())
    .addColumn("remarks", "text")
    .addColumn("aliases", "jsonb", (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .execute();

  await db.schema
    .createTable("sanctions_list_versions")
    .addColumn("id", "serial", (c) => c.primaryKey())
    .addColumn("content_hash", "text", (c) => c.notNull())
    .addColumn("last_modified", "text")
    .addColumn("entity_count", "integer", (c) => c.notNull())
    .addColumn("added_count", "integer", (c) => c.notNull())
    .addColumn("fetched_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
}

// biome-ignore lint/suspicious/noExplicitAny: Kysely's documented migration signature
export async function down(db: Kysely<any>): Promise<void> {
  for (const t of [
    "sanctions_list_versions",
    "sanctions_entities",
    "llm_calls",
    "ledger_entries",
    "approvals",
    "inbox",
    "outbox",
    "saga_history",
    "sagas",
    "sellers",
  ]) {
    await db.schema.dropTable(t).ifExists().execute();
  }
}
