import * as cheerio from "cheerio";

export interface Flag {
  kind: "prompt_injection" | "hidden_text";
  snippet: string;
}

/** Patterns that signal text addressed to an AI/agent rather than to a human reader. */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|context)/i,
  /disregard\s+.{0,40}\b(instructions?|rules?|guidelines?)/i,
  /\b(system|assistant|developer|admin)\s*(note|message|prompt|instruction|override)s?\s*(to\s+\w+\s*)?[:\]\-–]/i,
  /\b(allocate|assign|give|pay|route|send|direct|credit|attribute)\b.{0,50}\b(100\s?%|all|entire|full|whole|every)\b.{0,50}\b(royalt|fee|payment|payout|funds?|share|credit|money)/i,
  /\bpay\s+(me|us|this\s+(site|author|page))\b.{0,40}\b(100|all|first|more|extra|double)/i,
  /\b(to|for)\s+(any\s+|the\s+|all\s+)?(AI|LLM|language\s+model|assistant|agent|crawler|bot)s?\b.{0,60}\b(must|should|please|always|ignore|rate|score|rank|cite|prioriti[sz]e)/i,
  /\b(rate|score|rank)\s+(this|the)\s+(page|source|site|article)\b.{0,30}\b(10|highest|maximum|max|best|top|1\.0|100)/i,
  /\b(change|update|replace|redirect|use)\b.{0,40}\b(payee|paypal|recipient|payout|payment)\b.{0,20}\b(email|address|account|destination)/i,
  /<\/?\s*(system|instructions?|admin)\s*>/i,
  /\byou\s+are\s+now\b/i,
];

const ZERO_WIDTH = /[​-‏⁠﻿‪-‮]/g;

export function looksLikeInjection(line: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(line));
}

export interface CleanText {
  text: string;
  flags: Flag[];
}

/** Strip injection lines from plain text, returning clean text plus flags. */
export function stripInjection(raw: string): CleanText {
  const flags: Flag[] = [];
  const kept: string[] = [];
  for (const line of raw.replace(ZERO_WIDTH, "").split(/\n+/)) {
    const t = line.trim();
    if (!t) continue;
    // Split long paragraphs into sentences so one hostile sentence doesn't discard the whole paragraph.
    const sentences = t.split(/(?<=[.!?])\s+/);
    const good: string[] = [];
    for (const s of sentences) {
      if (looksLikeInjection(s)) flags.push({ kind: "prompt_injection", snippet: s.slice(0, 240) });
      else good.push(s);
    }
    if (good.length) kept.push(good.join(" "));
  }
  return { text: kept.join("\n"), flags };
}

const HIDDEN_STYLE = /(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0(\.0+)?\b|left\s*:\s*-\d{3,}|text-indent\s*:\s*-\d{3,}|color\s*:\s*(#fff(fff)?|white)\b)/i;

export interface PageText {
  title: string;
  text: string;
  flags: Flag[];
  metaTags: Record<string, string>;
  links: string[];
}

/** HTML -> clean, injection-free visible text. Hidden elements and comments are removed and flagged if hostile. */
export function htmlToCleanText(html: string): PageText {
  const $ = cheerio.load(html);
  const metaTags: Record<string, string> = {};
  $("meta").each((_, el) => {
    const name = ($(el).attr("name") || $(el).attr("property") || "").toLowerCase();
    const content = $(el).attr("content");
    if (name && content) metaTags[name] = content;
  });
  const links = $("a[href]").map((_, el) => $(el).attr("href") || "").get();
  const title = ($("title").first().text() || $("h1").first().text() || "").trim();

  const flags: Flag[] = [];
  // Hidden content: never shown to humans, so it can only exist to talk to machines.
  $("[hidden], [aria-hidden='true'], [style]").each((_, el) => {
    const style = $(el).attr("style") || "";
    const isHidden = $(el).is("[hidden], [aria-hidden='true']") || HIDDEN_STYLE.test(style);
    if (!isHidden) return;
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t) flags.push({ kind: looksLikeInjection(t) ? "prompt_injection" : "hidden_text", snippet: t.slice(0, 240) });
    $(el).remove();
  });
  $("script, style, noscript, template, svg, iframe, nav, footer").remove();
  // HTML comments can carry instructions
  $("*")
    .contents()
    .filter((_, n) => n.type === "comment")
    .each((_, n) => {
      const t = (("data" in n ? (n as unknown as { data: string }).data : "") || "").trim();
      if (t && looksLikeInjection(t)) flags.push({ kind: "prompt_injection", snippet: t.slice(0, 240) });
      $(n).remove();
    });

  const blocks: string[] = [];
  $("h1,h2,h3,h4,p,li,blockquote,td,th,figcaption,pre").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t) blocks.push(t);
  });
  const body = blocks.length ? blocks.join("\n") : $("body").text().replace(/[ \t]+/g, " ");
  const clean = stripInjection(body);
  return {
    title,
    text: clean.text,
    flags: dedupeFlags([...flags.filter((f) => f.kind === "prompt_injection" || f.kind === "hidden_text"), ...clean.flags]),
    metaTags,
    links,
  };
}

function dedupeFlags(flags: Flag[]): Flag[] {
  const seen = new Set<string>();
  return flags.filter((f) => (seen.has(f.snippet) ? false : (seen.add(f.snippet), true)));
}

/** A page is "flagged" only for hostile content, not for merely having hidden decoration. */
export const isHostile = (flags: Flag[]) => flags.some((f) => f.kind === "prompt_injection");
