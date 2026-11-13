export interface LeiRecord {
  lei: string;
  legalName: string;
  country: string | null;
  status: string | null;
}

interface GleifResponse {
  data?: Array<{
    attributes: {
      lei: string;
      entity?: {
        legalName?: { name?: string };
        legalAddress?: { country?: string };
        status?: string;
      };
    };
  }>;
}

/** Content Enricher: looks up the seller's legal entity record. A failure is evidence, not an error. */
export async function findLei(name: string, fetchImpl = fetch): Promise<LeiRecord | null> {
  const url = new URL("https://api.gleif.org/api/v1/lei-records");
  url.searchParams.set("filter[fulltext]", name);
  url.searchParams.set("page[size]", "1");
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/vnd.api+json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as GleifResponse;
    const attrs = body.data?.[0]?.attributes;
    if (!attrs) return null;
    return {
      lei: attrs.lei,
      legalName: attrs.entity?.legalName?.name ?? "",
      country: attrs.entity?.legalAddress?.country ?? null,
      status: attrs.entity?.status ?? null,
    };
  } catch {
    return null;
  }
}
