import { nameScore } from "./similarity.js";

export interface SanctionedEntity {
  ent_num: number;
  name: string;
  program: string;
  remarks: string | null;
  aliases: string[];
}

export interface Candidate {
  entity: SanctionedEntity;
  matchedName: string;
  score: number;
}

export function topCandidates(
  sellerName: string,
  entities: readonly SanctionedEntity[],
  limit = 5,
): Candidate[] {
  const scored: Candidate[] = [];
  for (const entity of entities) {
    let best = { name: entity.name, score: nameScore(sellerName, entity.name) };
    for (const alias of entity.aliases) {
      const score = nameScore(sellerName, alias);
      if (score > best.score) best = { name: alias, score };
    }
    scored.push({ entity, matchedName: best.name, score: best.score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
