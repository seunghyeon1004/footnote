import Anthropic from "@anthropic-ai/sdk";
import type { LLM, ResearchCtx, ResearchResult, AttributionInput, AttributionScore, SettleTools } from "./types.js";
import { RESEARCH_SYSTEM, ATTRIBUTION_SYSTEM, SETTLE_SYSTEM, wrapUntrusted } from "./prompts.js";

interface Opts {
  apiKey?: string;
  model: string;
  webSearch: boolean;
  fallbacks: boolean;
  client?: Anthropic; // injectable for tests
}

const FETCH_TOOL = {
  name: "fetch_url",
  description: "Fetch a web page and return its visible text (sanitized). Use for URLs from search results or the Footnote library.",
  input_schema: { type: "object", properties: { url: { type: "string", description: "Absolute http(s) URL or a path from the library" } }, required: ["url"], additionalProperties: false },
};
const SUBMIT_TOOL = {
  name: "submit_answer",
  description: "Submit the final cited answer. Call exactly once when done.",
  input_schema: {
    type: "object",
    properties: {
      answer_markdown: { type: "string" },
      sources: {
        type: "array",
        items: { type: "object", properties: { n: { type: "integer" }, url: { type: "string" }, title: { type: "string" } }, required: ["n", "url", "title"], additionalProperties: false },
      },
    },
    required: ["answer_markdown", "sources"],
    additionalProperties: false,
  },
};

export function anthropicLLM(o: Opts): LLM {
  const client = o.client ?? new Anthropic({ apiKey: o.apiKey });
  let useFallbacks = o.fallbacks;

  /** One Messages API call. Opts in to the server-side refusal fallback; drops it if the API rejects it. */
  async function create(params: Record<string, unknown>): Promise<any> {
    const base = { model: o.model, max_tokens: 8000, ...params };
    if (useFallbacks) {
      try {
        return await (client.beta.messages as any).create({ ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
      } catch (e: any) {
        if (e?.status === 400 || e?.status === 404) useFallbacks = false; // unsupported on this key/platform: continue without
        else throw e;
      }
    }
    return client.messages.create(base as any);
  }

  const failOnRefusal = (r: any) => {
    if (r.stop_reason === "refusal") throw new Error(`model declined the request (${r.stop_details?.category ?? "policy"})`);
  };

  return {
    provider: "anthropic",
    model: o.model,
    fixture: false,

    async research(question: string, ctx: ResearchCtx): Promise<ResearchResult> {
      const library = ctx.library.map((l) => `- ${l.title}: ${l.url}`).join("\n");
      const system = `${RESEARCH_SYSTEM}\n\nFootnote library (registered creator sites):\n${library || "(none)"}`;
      const tools: any[] = [FETCH_TOOL, SUBMIT_TOOL];
      if (o.webSearch) tools.unshift({ type: "web_search_20260209", name: "web_search", max_uses: 5 });
      const messages: any[] = [{ role: "user", content: question }];
      let nudged = false;
      for (let turn = 0; turn < 14; turn++) {
        const r = await create({ system, tools, messages, output_config: { effort: "medium" } });
        failOnRefusal(r);
        messages.push({ role: "assistant", content: r.content });
        const uses = r.content.filter((b: any) => b.type === "tool_use");
        const results: any[] = [];
        for (const u of uses) {
          if (u.name === "submit_answer") {
            const inp = u.input as { answer_markdown: string; sources: { n: number; url: string; title: string }[] };
            if (inp?.answer_markdown && Array.isArray(inp.sources)) return { answerMarkdown: inp.answer_markdown, sources: inp.sources };
            results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: "submit_answer needs answer_markdown and sources[]" });
          } else if (u.name === "fetch_url") {
            try {
              const p = await ctx.fetchPage(String((u.input as any).url));
              ctx.log("researching", `Read ${p.title || p.url}${p.flags.some((f) => f.kind === "prompt_injection") ? " — hostile instructions stripped" : ""}`);
              results.push({ type: "tool_result", tool_use_id: u.id, content: wrapUntrusted(p.url, p.title, p.text) });
            } catch (e) {
              results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: `fetch failed: ${(e as Error).message}` });
            }
          } else {
            results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: `unknown tool ${u.name}` });
          }
        }
        if (results.length) messages.push({ role: "user", content: results });
        else if (r.stop_reason === "pause_turn") continue; // server tool still running: resend to continue
        else if (!nudged) {
          nudged = true;
          messages.push({ role: "user", content: "Please finish by calling submit_answer with the cited answer and sources." });
        } else break;
      }
      throw new Error("research agent did not submit an answer");
    },

    async attribute(input: AttributionInput): Promise<AttributionScore[]> {
      const body =
        `Question: ${input.question}\n\nFinal answer:\n${input.answerMarkdown}\n\nSources:\n` +
        input.sources.map((s) => `[${s.n}] ${wrapUntrusted(s.url, s.title, s.excerpt, 3500)}`).join("\n\n");
      const r = await create({
        system: ATTRIBUTION_SYSTEM,
        messages: [{ role: "user", content: body }],
        output_config: {
          effort: "low",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                scores: {
                  type: "array",
                  items: { type: "object", properties: { n: { type: "integer" }, score: { type: "number" }, justification: { type: "string" } }, required: ["n", "score", "justification"], additionalProperties: false },
                },
              },
              required: ["scores"],
              additionalProperties: false,
            },
          },
        },
      });
      failOnRefusal(r);
      const text = r.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      const j = JSON.parse(text);
      return j.scores as AttributionScore[];
    },

    async settle(tools: SettleTools) {
      const defs: any[] = [
        { name: "list_settleable_payees", description: "List payees whose accrued royalties reached the minimum payout, with exact amount_cents.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
        {
          name: "create_payout_batch",
          description: "Create a PayPal Payouts batch (POST /v1/payments/payouts). One item per payee; amount_cents must equal the listed balance.",
          input_schema: {
            type: "object",
            properties: { items: { type: "array", items: { type: "object", properties: { email: { type: "string" }, amount_cents: { type: "integer" } }, required: ["email", "amount_cents"], additionalProperties: false } } },
            required: ["items"],
            additionalProperties: false,
          },
        },
      ];
      const messages: any[] = [{ role: "user", content: `Settle royalties now. Minimum payout is ${tools.minPayoutCents} cents.` }];
      for (let turn = 0; turn < 6; turn++) {
        const r = await create({ system: SETTLE_SYSTEM, tools: defs, messages, max_tokens: 2000, output_config: { effort: "low" } });
        failOnRefusal(r);
        messages.push({ role: "assistant", content: r.content });
        const uses = r.content.filter((b: any) => b.type === "tool_use");
        if (!uses.length) {
          tools.log(r.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ").trim());
          return;
        }
        const results: any[] = [];
        for (const u of uses) {
          try {
            if (u.name === "list_settleable_payees") {
              results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(tools.listSettleable().map((p) => ({ email: p.email, amount_cents: p.cents, domains: p.domains }))) });
            } else if (u.name === "create_payout_batch") {
              const items = ((u.input as any).items as { email: string; amount_cents: number }[]).map((i) => ({ email: i.email, cents: i.amount_cents }));
              const b = await tools.createBatch(items);
              results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(b) });
            } else results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: "unknown tool" });
          } catch (e) {
            results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: (e as Error).message });
          }
        }
        messages.push({ role: "user", content: results });
      }
    },
  };
}
