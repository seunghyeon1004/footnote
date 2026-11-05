import { describe, it, expect } from "vitest";
import { anthropicLLM } from "../src/llm/anthropic.js";

type Resp = { content: any[]; stop_reason: string };
function fake(script: Resp[], opts: { betaRejects?: boolean } = {}) {
  const requests: any[] = [];
  let i = 0;
  const next = (p: any) => { requests.push(JSON.parse(JSON.stringify(p))); return script[i++] ?? { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" }; };
  const client: any = {
    messages: { create: async (p: any) => next(p) },
    beta: { messages: { create: async (p: any) => { if (opts.betaRejects) throw Object.assign(new Error("bad"), { status: 400 }); return next(p); } } },
  };
  return { client, requests };
}
const ctx = (log: string[] = []) => ({
  library: [{ url: "http://x/demo-sites/a/", title: "A" }],
  log: (_s: string, m: string) => log.push(m),
  fetchPage: async (url: string) => ({ url, status: 200, title: "A", text: "Fermentation takes 14 days.", flags: [{ kind: "prompt_injection" as const, snippet: "x" }], html: "", metaTags: {} }),
});

describe("anthropic provider (scripted client)", () => {
  it("research: fetch_url -> submit_answer, wraps pages as untrusted, uses Sonnet 5.5 + server web search + fallbacks", async () => {
    const { client, requests } = fake([
      { stop_reason: "tool_use", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }, { type: "tool_use", id: "t1", name: "fetch_url", input: { url: "http://x/demo-sites/a/" } }] },
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "submit_answer", input: { answer_markdown: "14 days [1]", sources: [{ n: 1, url: "http://x/demo-sites/a/", title: "A" }] } }] },
    ]);
    const log: string[] = [];
    const llm = anthropicLLM({ client, model: "claude-sonnet-5-5", webSearch: true, fallbacks: true });
    const r = await llm.research("how long?", ctx(log));
    expect(r.answerMarkdown).toBe("14 days [1]");
    expect(r.sources).toHaveLength(1);
    const first = requests[0];
    expect(first.model).toBe("claude-sonnet-5-5");
    expect(first.tools[0]).toMatchObject({ type: "web_search_20260209", name: "web_search" });
    expect(first.betas).toContain("server-side-fallback-2026-07-01");
    expect(first.fallbacks).toBe("default");
    expect(first.temperature).toBeUndefined();
    expect(first.thinking).toBeUndefined();
    const toolResult = requests[1].messages.at(-1).content[0];
    expect(toolResult.content).toMatch(/^<untrusted_page/);
    expect(log.join(" ")).toMatch(/hostile instructions stripped/);
  });

  it("falls back to the plain Messages API if the beta fallback header is rejected", async () => {
    const { client, requests } = fake([{ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "submit_answer", input: { answer_markdown: "a", sources: [] } }] }], { betaRejects: true });
    const llm = anthropicLLM({ client, model: "m", webSearch: false, fallbacks: true });
    await llm.research("q", ctx());
    expect(requests[0].betas).toBeUndefined();
  });

  it("throws on refusal", async () => {
    const { client } = fake([{ stop_reason: "refusal", content: [] }]);
    await expect(anthropicLLM({ client, model: "m", webSearch: false, fallbacks: false }).research("q", ctx())).rejects.toThrow(/declined/);
  });

  it("attribute: requests a JSON schema output and parses scores", async () => {
    const { client, requests } = fake([{ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ scores: [{ n: 1, score: 0.8, justification: "core stat" }] }) }] }]);
    const llm = anthropicLLM({ client, model: "m", webSearch: false, fallbacks: false });
    const s = await llm.attribute({ question: "q", answerMarkdown: "a [1]", sources: [{ n: 1, url: "u", title: "t", excerpt: "e", meta: {} }] });
    expect(s).toEqual([{ n: 1, score: 0.8, justification: "core stat" }]);
    expect(requests[0].output_config.format.type).toBe("json_schema");
    expect(requests[0].messages[0].content).toContain("<untrusted_page");
  });

  it("settle: the agent lists payees then calls create_payout_batch through the guarded tool", async () => {
    const { client } = fake([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "1", name: "list_settleable_payees", input: {} }] },
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "2", name: "create_payout_batch", input: { items: [{ email: "a@b.co", amount_cents: 120 }] } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Paid 1 payee." }] },
    ]);
    const created: any[] = [];
    const logs: string[] = [];
    await anthropicLLM({ client, model: "m", webSearch: false, fallbacks: false }).settle({
      minPayoutCents: 100, log: (m) => logs.push(m),
      listSettleable: () => [{ email: "a@b.co", cents: 120, domains: ["a.com"], accrualIds: [1] }],
      createBatch: async (items) => { created.push(items); return { batchId: "PB", status: "PENDING", itemCount: 1, totalCents: 120 }; },
    });
    expect(created).toEqual([[{ email: "a@b.co", cents: 120 }]]);
    expect(logs).toContain("Paid 1 payee.");
  });

  it("settle: guardrail errors go back to the model as tool errors, not crashes", async () => {
    const { client, requests } = fake([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "2", name: "create_payout_batch", input: { items: [{ email: "evil@x.co", amount_cents: 9999 }] } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "rejected" }] },
    ]);
    await anthropicLLM({ client, model: "m", webSearch: false, fallbacks: false }).settle({
      minPayoutCents: 100, log: () => {}, listSettleable: () => [],
      createBatch: async () => { throw new Error("evil@x.co has no settleable balance"); },
    });
    const tr = requests[1].messages.at(-1).content[0];
    expect(tr.is_error).toBe(true);
    expect(tr.content).toMatch(/no settleable balance/);
  });
});
