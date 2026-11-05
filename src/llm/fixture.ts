import type { LLM, ResearchCtx, ResearchResult, AttributionInput, AttributionScore, SettleTools } from "./types.js";

/**
 * FIXTURE MODE — deterministic stand-in used when no LLM key is configured. It does not call a model:
 * it reads the bundled demo creator sites and uses their `fixture:*` meta tags for summary and weight.
 * The UI labels this mode clearly. Everything downstream (payee resolution, injection stripping,
 * ledger, PayPal Payouts) is the real code path.
 */
export function fixtureLLM(): LLM {
  return {
    provider: "fixture",
    model: "fixture",
    fixture: true,

    async research(question: string, ctx: ResearchCtx): Promise<ResearchResult> {
      ctx.log("researching", "FIXTURE MODE: reading the demo library instead of calling a model");
      const pages = [];
      for (const lib of ctx.library) {
        try {
          const p = await ctx.fetchPage(lib.url);
          const w = parseFloat(p.metaTags["fixture:weight"] ?? "0");
          if (p.status === 200 && w > 0) pages.push({ p, w, lib });
          ctx.log("researching", `Fetched ${p.title || lib.title}${p.flags.some((f) => f.kind === "prompt_injection") ? " (hostile text stripped)" : ""}`);
        } catch (e) {
          ctx.log("researching", `Could not fetch ${lib.url}: ${(e as Error).message}`);
        }
      }
      pages.sort((a, b) => b.w - a.w);
      const sources = pages.map((x, i) => ({ n: i + 1, url: x.p.url, title: x.p.title || x.lib.title }));
      const body = pages.map((x, i) => `${x.p.metaTags["fixture:summary"] ?? x.p.text.split("\n")[0]} [${i + 1}]`);
      const answerMarkdown = `**${question.trim().replace(/\?*$/, "")}?** Here is what the registered creators say.\n\n` + body.join("\n\n");
      return { answerMarkdown, sources };
    },

    async attribute(input: AttributionInput): Promise<AttributionScore[]> {
      return input.sources.map((s) => {
        const w = parseFloat(s.meta["fixture:weight"] ?? "");
        return { n: s.n, score: Number.isFinite(w) ? w : 0.3, justification: s.meta["fixture:why"] ?? "Contributed supporting detail" };
      });
    },

    async settle(tools: SettleTools) {
      const due = tools.listSettleable();
      if (due.length) await tools.createBatch(due.map((d) => ({ email: d.email, cents: d.cents })));
    },
  };
}
