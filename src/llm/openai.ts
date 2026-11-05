import type { LLM, ResearchCtx, ResearchResult, AttributionInput, AttributionScore, SettleTools } from "./types.js";
import type { SearchFn } from "../search.js";
import { RESEARCH_SYSTEM, ATTRIBUTION_SYSTEM, SETTLE_SYSTEM, wrapUntrusted } from "./prompts.js";

/** OpenAI-compatible provider (Chat Completions + function calling). No built-in web search: it reads the library and any URL it is given/knows. */
export function openaiLLM(o: { apiKey: string; model: string; baseUrl?: string; fetch?: typeof fetch; search?: SearchFn }): LLM {
  const f = o.fetch ?? fetch;
  const base = o.baseUrl ?? "https://api.openai.com/v1";

  async function chat(body: Record<string, unknown>): Promise<any> {
    const res = await f(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: o.model, ...body }),
    });
    const j: any = await res.json();
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${j?.error?.message ?? "error"}`);
    return j.choices[0];
  }
  const fn = (name: string, description: string, parameters: object) => ({ type: "function", function: { name, description, parameters } });

  async function loop(system: string, user: string, tools: object[], handle: (name: string, args: any) => Promise<string | { done: unknown }>, maxTurns = 12, nudge?: string) {
    let nudged = false;
    const messages: any[] = [{ role: "system", content: system }, { role: "user", content: user }];
    for (let t = 0; t < maxTurns; t++) {
      const c = await chat({ messages, tools });
      const m = c.message;
      messages.push(m);
      if (!m.tool_calls?.length) {
        if (nudge && !nudged) { nudged = true; messages.push({ role: "user", content: nudge }); continue; }
        return { text: m.content as string };
      }
      for (const tc of m.tool_calls) {
        let out: string | { done: unknown };
        try { out = await handle(tc.function.name, JSON.parse(tc.function.arguments || "{}")); } catch (e) { out = `error: ${(e as Error).message}`; }
        if (typeof out !== "string") return { done: out.done };
        messages.push({ role: "tool", tool_call_id: tc.id, content: out });
      }
    }
    throw new Error("agent loop exceeded turn budget");
  }

  return {
    provider: "openai",
    model: o.model,
    fixture: false,

    async research(question: string, ctx: ResearchCtx): Promise<ResearchResult> {
      const library = ctx.library.map((l) => `- ${l.title}: ${l.url}`).join("\n");
      const r = await loop(
        `${RESEARCH_SYSTEM}\n\nFootnote library:\n${library}`,
        question,
        [
          ...(o.search ? [fn("web_search", "Search the web; returns titles, URLs, snippets", { type: "object", properties: { query: { type: "string" } }, required: ["query"] })] : []),
          fn("fetch_url", "Fetch a page and return sanitized visible text", { type: "object", properties: { url: { type: "string" } }, required: ["url"] }),
          fn("submit_answer", "Submit the final cited answer", {
            type: "object",
            properties: { answer_markdown: { type: "string" }, sources: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, url: { type: "string" }, title: { type: "string" } }, required: ["n", "url", "title"] } } },
            required: ["answer_markdown", "sources"],
          }),
        ],
        async (name, args) => {
          if (name === "web_search" && o.search) { ctx.log("researching", `Searching the web: ${String(args.query).slice(0, 80)}`); return o.search(String(args.query)); }
          if (name === "fetch_url") {
            const p = await ctx.fetchPage(String(args.url));
            ctx.log("researching", `Read ${p.title || p.url}`);
            return wrapUntrusted(p.url, p.title, p.text);
          }
          if (name === "submit_answer") return { done: { answerMarkdown: args.answer_markdown, sources: args.sources } };
          return "unknown tool";
        },
        12,
        "You have not submitted yet. Call submit_answer now with the cited answer and the sources you used."
      );
      if (!("done" in r) || !r.done) throw new Error("research agent did not submit an answer");
      return r.done as ResearchResult;
    },

    async attribute(input: AttributionInput): Promise<AttributionScore[]> {
      const body = `Question: ${input.question}\n\nFinal answer:\n${input.answerMarkdown}\n\nSources:\n` + input.sources.map((s) => `[${s.n}] ${wrapUntrusted(s.url, s.title, s.excerpt, 3500)}`).join("\n\n");
      const c = await chat({
        messages: [{ role: "system", content: ATTRIBUTION_SYSTEM + ' Reply as JSON: {"scores":[{"n":1,"score":0.5,"justification":"..."}]}' }, { role: "user", content: body }],
        response_format: { type: "json_object" },
      });
      return JSON.parse(c.message.content).scores as AttributionScore[];
    },

    async settle(tools: SettleTools) {
      await loop(
        SETTLE_SYSTEM,
        `Settle royalties now. Minimum payout is ${tools.minPayoutCents} cents.`,
        [
          fn("list_settleable_payees", "List payees at/above the minimum with exact amount_cents", { type: "object", properties: {} }),
          fn("create_payout_batch", "Create a PayPal Payouts batch", { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { email: { type: "string" }, amount_cents: { type: "integer" } }, required: ["email", "amount_cents"] } } }, required: ["items"] }),
        ],
        async (name, args) => {
          if (name === "list_settleable_payees") return JSON.stringify(tools.listSettleable().map((p) => ({ email: p.email, amount_cents: p.cents })));
          if (name === "create_payout_batch") return JSON.stringify(await tools.createBatch((args.items as any[]).map((i) => ({ email: i.email, cents: i.amount_cents }))));
          return "unknown tool";
        },
        6
      );
    },
  };
}
