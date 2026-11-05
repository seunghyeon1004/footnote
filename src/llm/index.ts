import type { Config } from "../config.js";
import type { LLM } from "./types.js";
import { anthropicLLM } from "./anthropic.js";
import { openaiLLM } from "./openai.js";
import { geminiLLM } from "./gemini.js";
import { serperSearch } from "../search.js";
import { fixtureLLM } from "./fixture.js";

export function makeLLM(cfg: Config, env: NodeJS.ProcessEnv = process.env): LLM {
  if (cfg.llm.provider === "anthropic") return anthropicLLM({ apiKey: env.ANTHROPIC_API_KEY, model: cfg.llm.model, webSearch: cfg.llm.webSearch, fallbacks: cfg.llm.fallbacks });
  if (cfg.llm.provider === "openai") return openaiLLM({ apiKey: env.OPENAI_API_KEY!, model: cfg.llm.model, search: cfg.llm.webSearch && env.SERPER_API_KEY ? serperSearch(env.SERPER_API_KEY) : undefined });
  if (cfg.llm.provider === "vultr")
    return openaiLLM({ apiKey: env.VULTR_API_KEY!, model: cfg.llm.model, baseUrl: env.VULTR_BASE_URL || "https://api.vultrinference.com/v1", name: "vultr", search: cfg.llm.webSearch && env.SERPER_API_KEY ? serperSearch(env.SERPER_API_KEY) : undefined });
  if (cfg.llm.provider === "gemini") return geminiLLM({ apiKey: env.GEMINI_API_KEY!, model: cfg.llm.model, search: cfg.llm.webSearch && env.SERPER_API_KEY ? serperSearch(env.SERPER_API_KEY) : undefined });
  return fixtureLLM();
}
export type { LLM } from "./types.js";
