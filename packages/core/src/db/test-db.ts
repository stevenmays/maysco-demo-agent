import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect } from "kysely";
import { migrateToLatest } from "./client.js";
import type { Database } from "./types.js";

// In-process Postgres for tests. One connection, so it can't prove a race between
// two Lambdas; tests that need real concurrency run against a Neon branch.
export async function createTestDb(): Promise<Kysely<Database>> {
  const db = new Kysely<Database>({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
  await migrateToLatest(db);
  return db;
}
