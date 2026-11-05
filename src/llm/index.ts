import type { Config } from "../config.js";
import type { LLM } from "./types.js";
import { anthropicLLM } from "./anthropic.js";
import { openaiLLM } from "./openai.js";
import { fixtureLLM } from "./fixture.js";

export function makeLLM(cfg: Config, env: NodeJS.ProcessEnv = process.env): LLM {
  if (cfg.llm.provider === "anthropic") return anthropicLLM({ apiKey: env.ANTHROPIC_API_KEY, model: cfg.llm.model, webSearch: cfg.llm.webSearch, fallbacks: cfg.llm.fallbacks });
  if (cfg.llm.provider === "openai") return openaiLLM({ apiKey: env.OPENAI_API_KEY!, model: cfg.llm.model });
  return fixtureLLM();
}
export type { LLM } from "./types.js";
