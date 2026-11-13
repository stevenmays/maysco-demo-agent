const LEGAL_FORMS = new Set([
  "AG",
  "BV",
  "CO",
  "COMPANY",
  "CORP",
  "CORPORATION",
  "FZCO",
  "FZE",
  "GMBH",
  "INC",
  "INCORPORATED",
  "JSC",
  "LIMITED",
  "LLC",
  "LLP",
  "LP",
  "LTD",
  "NV",
  "OJSC",
  "OOO",
  "PJSC",
  "PLC",
  "SA",
  "SARL",
  "SPA",
  "SRL",
  "THE",
]);

export function normalizeName(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !LEGAL_FORMS.has(t));
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  for (let i = 0, j = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[j]) j++;
    if (a[i] !== b[j++]) transpositions++;
  }
  const jaro =
    (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

const STOP_WORDS = new Set(["AND", "OF", "FOR", "DE", "LA", "EL", "THE"]);

// Average over a's tokens of each token's best Jaro-Winkler match in b (Monge-Elkan).
function mongeElkan(a: string[], b: string[]): number {
  let total = 0;
  for (const ta of a) total += Math.max(...b.map((tb) => jaroWinkler(ta, tb)));
  return total / a.length;
}

/** Order-insensitive name similarity in [0, 1], ignoring legal forms and punctuation. */
export function nameScore(a: string, b: string): number {
  const ta = normalizeName(a).filter((t) => !STOP_WORDS.has(t));
  const tb = normalizeName(b).filter((t) => !STOP_WORDS.has(t));
  if (!ta.length || !tb.length) return 0;
  const tokens = (mongeElkan(ta, tb) + mongeElkan(tb, ta)) / 2;
  // Catches spacing differences such as "AERO CARIBBEAN" vs "AEROCARIBBEAN".
  const compact = jaroWinkler(ta.join(""), tb.join(""));
  return Math.max(tokens, compact >= 0.95 ? compact : 0);
}
