import { describe, it, expect } from "vitest";
import { geminiLLM } from "../src/llm/gemini.js";
import { loadConfig } from "../src/config.js";

function scripted(parts: any[][]) {
  const bodies: any[] = [];
  let i = 0;
  const f = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    const p = parts[i++] ?? [{ text: "done" }];
    return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: p }, finishReason: "STOP" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, bodies };
}
const ctx = {
  library: [],
  log: () => {},
  fetchPage: async (url: string) => ({ url, status: 200, title: "T", text: "body", flags: [], html: "", metaTags: {} }),
};

describe("gemini provider", () => {
  it("research: search -> fetch -> (nudged) submit_answer", async () => {
    const { f, bodies } = scripted([
      [{ functionCall: { name: "web_search", args: { query: "bokashi" } } }],
      [{ functionCall: { name: "fetch_url", args: { url: "http://x/" } } }],
      [{ text: "I think the answer is 14 days." }], // no submit -> nudge
      [{ functionCall: { name: "submit_answer", args: { answer_markdown: "14 days [1]", sources: [{ n: 1, url: "http://x/", title: "T" }] } } }],
    ]);
    const llm = geminiLLM({ apiKey: "k", model: "m", fetch: f, search: async (q) => `1. result for ${q}` });
    const r = await llm.research("how long?", ctx);
    expect(r.answerMarkdown).toBe("14 days [1]");
    expect(bodies[0].tools[0].functionDeclarations.map((d: any) => d.name)).toContain("web_search");
    expect(JSON.stringify(bodies[1])).toContain("result for bokashi");
    expect(JSON.stringify(bodies[3])).toContain("not submitted yet");
  });

  it("attribute: JSON schema output", async () => {
    const { f, bodies } = scripted([[{ text: JSON.stringify({ scores: [{ n: 1, score: 0.7, justification: "j" }] }) }]]);
    const s = await geminiLLM({ apiKey: "k", model: "m", fetch: f }).attribute({ question: "q", answerMarkdown: "a", sources: [{ n: 1, url: "u", title: "t", excerpt: "e", meta: {} }] });
    expect(s[0].score).toBe(0.7);
    expect(bodies[0].generationConfig.responseMimeType).toBe("application/json");
  });

  it("settle: tool errors from the ledger are returned to the model", async () => {
    const { f, bodies } = scripted([[{ functionCall: { name: "create_payout_batch", args: { items: [{ email: "x@y.co", amount_cents: 5 }] } } }], [{ text: "ok" }]]);
    await geminiLLM({ apiKey: "k", model: "m", fetch: f }).settle({ minPayoutCents: 100, log: () => {}, listSettleable: () => [], createBatch: async () => { throw new Error("no balance"); } });
    expect(JSON.stringify(bodies[1])).toContain("error: no balance");
  });
});

describe("config", () => {
  it("picks providers by key, anthropic first, with overrides", () => {
    expect(loadConfig({}).llm.provider).toBe("fixture");
    expect(loadConfig({ GEMINI_API_KEY: "g" } as any).llm).toMatchObject({ provider: "gemini", model: "gemini-2.5-flash" });
    expect(loadConfig({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" } as any).llm).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(loadConfig({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a", LLM_PROVIDER: "gemini" } as any).llm.provider).toBe("gemini");
    expect(loadConfig({ ANTHROPIC_API_KEY: "a", LLM_PROVIDER: "fixture" } as any).llm.provider).toBe("fixture");
  });
  it("uses the simulator unless both PayPal credentials are present", () => {
    expect(loadConfig({}).paypal.simulator).toBe(true);
    expect(loadConfig({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b" } as any)).toMatchObject({ paypal: { simulator: false, baseUrl: "https://api-m.sandbox.paypal.com" } });
    expect(loadConfig({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b", PAYPAL_SIMULATOR: "1" } as any).paypal.simulator).toBe(true);
  });
  it("derives PUBLIC_URL from Render", () => {
    expect(loadConfig({ RENDER_EXTERNAL_URL: "https://footnote.onrender.com/" } as any).publicUrl).toBe("https://footnote.onrender.com");
  });
});
