/** Optional web search for providers without a built-in search tool (Serper.dev, Google results). */
export type SearchFn = (query: string) => Promise<string>;

export function serperSearch(apiKey: string, f: typeof fetch = fetch): SearchFn {
  return async (query: string) => {
    const res = await f("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ q: query, num: 8 }),
    });
    if (!res.ok) throw new Error(`search failed (${res.status})`);
    const j: any = await res.json();
    const rows = (j.organic ?? []).slice(0, 8).map((r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.link}\n   ${r.snippet ?? ""}`);
    return rows.length ? rows.join("\n") : "no results";
  };
}
