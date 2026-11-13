import type { Db } from "../db/client.js";
import type { SanctionedEntity } from "./match.js";

let cache: { versionId: number; entities: SanctionedEntity[] } | null = null;

/** Loads the current list once per Lambda container and list version. */
export async function loadEntities(db: Db): Promise<SanctionedEntity[]> {
  const version = await db
    .selectFrom("sanctions_list_versions")
    .select("id")
    .orderBy("id", "desc")
    .executeTakeFirst();
  const versionId = version?.id ?? 0;
  if (cache?.versionId === versionId) return cache.entities;
  const entities = await db.selectFrom("sanctions_entities").selectAll().execute();
  cache = { versionId, entities };
  return entities;
}
