import { createHash } from "node:crypto";
import type { Deps } from "../deps.js";
import { commit } from "../saga/unit-of-work.js";
import { diffEntities, parseEntities } from "./sdn.js";

const MIN_ENTITIES = 1_000;

export interface PollResult {
  changed: boolean;
  added: number[];
  removed: number[];
}

async function download(url: string, headers: Record<string, string>, fetchImpl: typeof fetch) {
  const res = await fetchImpl(url, {
    headers: { "user-agent": "sanctions-screening-demo", ...headers },
  });
  if (res.status === 304) return null;
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, lastModified: res.headers.get("last-modified") };
}

/**
 * Turns "the list changed" into an event. Treasury ignores If-Modified-Since, so the
 * poller hashes the body and emits only when the content changed.
 */
export async function pollSanctions(
  deps: Pick<Deps, "db" | "queue">,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PollResult> {
  const unchanged = { changed: false, added: [], removed: [] };
  const last = await deps.db
    .selectFrom("sanctions_list_versions")
    .selectAll()
    .orderBy("id", "desc")
    .executeTakeFirst();

  const sdn = await download(
    `${baseUrl}/SDN.CSV`,
    last?.last_modified ? { "if-modified-since": last.last_modified } : {},
    fetchImpl,
  );
  if (!sdn) return unchanged;
  const contentHash = createHash("sha256").update(sdn.bytes).digest("hex");
  if (contentHash === last?.content_hash) return unchanged;

  const alt = await download(`${baseUrl}/ALT.CSV`, {}, fetchImpl);
  const decode = (b: Uint8Array) => new TextDecoder("windows-1252").decode(b);
  const entities = parseEntities(decode(sdn.bytes), alt ? decode(alt.bytes) : "");
  // A truncated download must not wipe the list.
  if (entities.length < MIN_ENTITIES) {
    throw new Error(`Refusing a sanctions list with only ${entities.length} entities`);
  }

  const existing = await deps.db.selectFrom("sanctions_entities").select("ent_num").execute();
  const { added, removed } = diffEntities(new Set(existing.map((e) => e.ent_num)), entities);

  await commit(deps.db, deps.queue, async (tx) => {
    for (let i = 0; i < entities.length; i += 500) {
      const chunk = entities
        .slice(i, i + 500)
        .map((e) => ({ ...e, aliases: JSON.stringify(e.aliases) }));
      await tx.trx
        .insertInto("sanctions_entities")
        .values(chunk)
        .onConflict((oc) =>
          oc.column("ent_num").doUpdateSet((eb) => ({
            name: eb.ref("excluded.name"),
            program: eb.ref("excluded.program"),
            remarks: eb.ref("excluded.remarks"),
            aliases: eb.ref("excluded.aliases"),
          })),
        )
        .execute();
    }
    if (removed.length) {
      await tx.trx.deleteFrom("sanctions_entities").where("ent_num", "in", removed).execute();
    }
    await tx.trx
      .insertInto("sanctions_list_versions")
      .values({
        content_hash: contentHash,
        last_modified: sdn.lastModified,
        entity_count: entities.length,
        added_count: last ? added.length : 0,
      })
      .execute();
    // The first load is a baseline, not 10,000 "new" entries.
    if (last && added.length) await tx.emit(null, { kind: "list.changed", added });
  });
  return { changed: true, added: last ? added : [], removed };
}
