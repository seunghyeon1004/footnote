import type { LLM, ResearchCtx, ResearchResult, AttributionInput, AttributionScore, SettleTools } from "./types.js";
import { RESEARCH_SYSTEM, ATTRIBUTION_SYSTEM, SETTLE_SYSTEM, wrapUntrusted } from "./prompts.js";
import type { SearchFn } from "../search.js";

interface Opts {
  apiKey: string;
  model: string;
  search?: SearchFn;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Google Gemini provider (generateContent + function calling + JSON schema output). Web search via Serper when configured. */
export function geminiLLM(o: Opts): LLM {
  const f = o.fetch ?? fetch;
  const base = o.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";

  async function gen(body: Record<string, unknown>): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const res = await f(`${base}/models/${o.model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": o.apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j: any = await res.json().catch(() => ({}));
      if (res.ok) return j;
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const hinted = /retry in ([\d.]+)s/i.exec(j?.error?.message ?? "")?.[1];
        const waitMs = Math.min(65_000, hinted ? Math.ceil(parseFloat(hinted) * 1000) + 500 : 1200 * (attempt + 1));
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw new Error(`Gemini ${res.status}: ${j?.error?.message ?? "error"}`);
    }
  }
  const decl = (name: string, description: string, parameters: object) => ({ name, description, parameters });

  /** Function-calling loop. `handle` returns a string result or {done}. */
  async function loop(system: string, user: string, decls: object[], handle: (name: string, args: any) => Promise<string | { done: unknown }>, maxTurns: number, nudge?: string) {
    let nudged = false;
    const contents: any[] = [{ role: "user", parts: [{ text: user }] }];
    for (let t = 0; t < maxTurns; t++) {
      const j = await gen({ systemInstruction: { parts: [{ text: system }] }, contents, tools: [{ functionDeclarations: decls }] });
      const cand = j.candidates?.[0];
      if (!cand?.content) throw new Error(`Gemini returned no content (${cand?.finishReason ?? j.promptFeedback?.blockReason ?? "unknown"})`);
      contents.push(cand.content); // keep verbatim: preserves thought signatures
      const calls = (cand.content.parts ?? []).filter((p: any) => p.functionCall);
      if (!calls.length && nudge && !nudged) {
        nudged = true;
        contents.push({ role: "user", parts: [{ text: nudge }] });
        continue;
      }
      if (!calls.length) return { text: (cand.content.parts ?? []).map((p: any) => p.text ?? "").join("") };
      const responses: any[] = [];
      for (const c of calls) {
        let out: string | { done: unknown };
        try { out = await handle(c.functionCall.name, c.functionCall.args ?? {}); } catch (e) { out = `error: ${(e as Error).message}`; }
        if (typeof out !== "string") return { done: out.done };
        responses.push({ functionResponse: { name: c.functionCall.name, response: { result: out } } });
      }
      contents.push({ role: "user", parts: responses });
    }
    throw new Error("agent loop exceeded turn budget");
  }

  return {
    provider: "gemini",
    model: o.model,
    fixture: false,

    async research(question: string, ctx: ResearchCtx): Promise<ResearchResult> {
      const library = ctx.library.map((l) => `- ${l.title}: ${l.url}`).join("\n");
      const decls = [
        decl("fetch_url", "Fetch a web page and return its sanitized visible text.", { type: "object", properties: { url: { type: "string" } }, required: ["url"] }),
        decl("submit_answer", "Submit the final cited answer. Call exactly once when done.", {
          type: "object",
          properties: {
            answer_markdown: { type: "string" },
            sources: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, url: { type: "string" }, title: { type: "string" } }, required: ["n", "url", "title"] } },
          },
          required: ["answer_markdown", "sources"],
        }),
      ];
      if (o.search) decls.unshift(decl("web_search", "Search the web. Returns titles, URLs and snippets; then fetch_url the promising ones.", { type: "object", properties: { query: { type: "string" } }, required: ["query"] }));
      const r = await loop(
        `${RESEARCH_SYSTEM}\n\nFootnote library (registered creator sites):\n${library}`,
        question,
        decls,
        async (name, args) => {
          if (name === "web_search" && o.search) {
            ctx.log("researching", `Searching the web: ${String(args.query).slice(0, 80)}`);
            return o.search(String(args.query));
          }
          if (name === "fetch_url") {
            const p = await ctx.fetchPage(String(args.url));
            ctx.log("researching", `Read ${p.title || p.url}${p.flags.some((x) => x.kind === "prompt_injection") ? " — hostile instructions stripped" : ""}`);
            return wrapUntrusted(p.url, p.title, p.text);
          }
          if (name === "submit_answer") return { done: { answerMarkdown: args.answer_markdown, sources: args.sources } };
          return "unknown tool";
        },
        14,
        "You have not submitted yet. Call submit_answer now with the cited answer and the sources you used."
      );
      if (!("done" in r) || !r.done) throw new Error("research agent did not submit an answer");
      return r.done as ResearchResult;
    },

    async attribute(input: AttributionInput): Promise<AttributionScore[]> {
      const body = `Question: ${input.question}\n\nFinal answer:\n${input.answerMarkdown}\n\nSources:\n` + input.sources.map((s) => `[${s.n}] ${wrapUntrusted(s.url, s.title, s.excerpt, 3500)}`).join("\n\n");
      const j = await gen({
        systemInstruction: { parts: [{ text: ATTRIBUTION_SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: body }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: { scores: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, score: { type: "number" }, justification: { type: "string" } }, required: ["n", "score", "justification"] } } },
            required: ["scores"],
          },
        },
      });
      const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
      return JSON.parse(text).scores as AttributionScore[];
    },

    async settle(tools: SettleTools) {
      await loop(
        SETTLE_SYSTEM,
        `Settle royalties now. Minimum payout is ${tools.minPayoutCents} cents.`,
        [
          decl("list_settleable_payees", "List payees at/above the minimum with exact amount_cents.", { type: "object", properties: {} }),
          decl("create_payout_batch", "Create a PayPal Payouts batch (POST /v1/payments/payouts). amount_cents must equal the listed balance.", {
            type: "object",
            properties: { items: { type: "array", items: { type: "object", properties: { email: { type: "string" }, amount_cents: { type: "integer" } }, required: ["email", "amount_cents"] } } },
            required: ["items"],
          }),
        ],
        async (name, args) => {
          if (name === "list_settleable_payees") return JSON.stringify(tools.listSettleable().map((p) => ({ email: p.email, amount_cents: p.cents, domains: p.domains })));
          if (name === "create_payout_batch") return JSON.stringify(await tools.createBatch((args.items as any[]).map((i) => ({ email: i.email, cents: i.amount_cents }))));
          return "unknown tool";
        },
        6
      );
    },
  };
}
