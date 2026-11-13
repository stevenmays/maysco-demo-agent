import { Pool } from "@neondatabase/serverless";
import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Migrator } from "kysely/migration";
import { migrations } from "./migrations/index.js";
import type { Database } from "./types.js";

export type Db = Kysely<Database>;

let cached: Db | null = null;

export function connect(connectionString: string): Db {
  cached ??= new Kysely<Database>({
    // Neon's Pool speaks the pg API over WebSockets; its types lag Kysely 0.29's.
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString, max: 1 }) as unknown as PostgresPool,
    }),
  });
  return cached;
}

export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const { error, results } = await new Migrator({ db, provider: migrations }).migrateToLatest();
  for (const r of results ?? []) console.log(`${r.status}: ${r.migrationName}`);
  if (error) throw error;
}
