import type { Flag } from "../sanitize.js";
import type { SettleablePayee, BatchResult } from "../ledger.js";

export interface PageRecord {
  url: string;
  status: number;
  title: string;
  text: string; // sanitized, injection-free
  flags: Flag[];
  html: string; // raw, only used for payee resolution
  metaTags: Record<string, string>;
}

export interface ResearchCtx {
  fetchPage(url: string): Promise<PageRecord>;
  log(stage: string, message: string): void;
  /** Creator sites registered in the Footnote library (the bundled demo sites). */
  library: { url: string; title: string }[];
}

export interface ResearchResult {
  answerMarkdown: string;
  sources: { n: number; url: string; title: string }[];
}

export interface AttributionInput {
  question: string;
  answerMarkdown: string;
  sources: { n: number; url: string; title: string; excerpt: string; meta: Record<string, string> }[];
}
export interface AttributionScore {
  n: number;
  score: number;
  justification: string;
}

export interface SettleTools {
  listSettleable(): SettleablePayee[];
  createBatch(items: { email: string; cents: number }[]): Promise<BatchResult>;
  log(message: string): void;
  minPayoutCents: number;
}

export interface LLM {
  provider: "anthropic" | "openai" | "fixture";
  model: string;
  fixture: boolean;
  research(question: string, ctx: ResearchCtx): Promise<ResearchResult>;
  attribute(input: AttributionInput): Promise<AttributionScore[]>;
  /** Agentic settlement: the model decides which payouts to execute through PayPal tools. */
  settle(tools: SettleTools): Promise<void>;
}
