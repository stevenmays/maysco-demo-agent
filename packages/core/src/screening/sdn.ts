import type { SanctionedEntity } from "./match.js";

/** Minimal CSV parser for OFAC's quoted, comma-separated export files. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\u001a") field += ch;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

const clean = (v: string | undefined) => {
  const t = (v ?? "").trim();
  return t === "" || t === "-0-" ? null : t;
};

/** SDN.CSV columns: ent_num, name, type, program, ..., remarks. Entities have no type. */
export function parseEntities(sdnCsv: string, altCsv: string): SanctionedEntity[] {
  const aliases = new Map<number, string[]>();
  for (const [entNum, , , altName] of parseCsv(altCsv)) {
    const id = Number(entNum);
    const name = clean(altName);
    if (!Number.isInteger(id) || !name) continue;
    aliases.set(id, [...(aliases.get(id) ?? []), name]);
  }
  const entities: SanctionedEntity[] = [];
  for (const cols of parseCsv(sdnCsv)) {
    const id = Number(cols[0]);
    const name = clean(cols[1]);
    if (!Number.isInteger(id) || !name || clean(cols[2]) !== null) continue;
    entities.push({
      ent_num: id,
      name,
      program: clean(cols[3]) ?? "",
      remarks: clean(cols[11]),
      aliases: aliases.get(id) ?? [],
    });
  }
  return entities;
}

export function diffEntities(previous: Set<number>, next: SanctionedEntity[]) {
  const nextIds = new Set(next.map((e) => e.ent_num));
  return {
    added: next.filter((e) => !previous.has(e.ent_num)).map((e) => e.ent_num),
    removed: [...previous].filter((id) => !nextIds.has(id)),
  };
}
