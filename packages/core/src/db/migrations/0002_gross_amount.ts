import type { Kysely } from "kysely";

// biome-ignore lint/suspicious/noExplicitAny: Kysely's documented migration signature
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("sagas").addColumn("gross_amount", "integer").execute();
}

// biome-ignore lint/suspicious/noExplicitAny: Kysely's documented migration signature
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("sagas").dropColumn("gross_amount").execute();
}
