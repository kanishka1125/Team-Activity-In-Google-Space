import OpenAI from "openai";

import { readLlmConfig } from "../config/runtimeConfig.js";

// ---------------------------------------------------------------
// AI helper used ONLY for the daily Good Morning quote.
//
// Copied unchanged from the AIOS backend's llm.service.ts (just the
// parts the quote uses), so this standalone project doesn't need
// the AIOS Chat / PMS modules that llm.service.ts also loads.
// Settings: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL (all optional; without
// them Good Morning uses a built-in quote).
// ---------------------------------------------------------------

// Thrown when AI features are used but LLM_BASE_URL / LLM_API_KEY
// are not set. The backend itself keeps running.
export class LlmNotConfiguredError extends Error {
  readonly code = "LLM_NOT_CONFIGURED";

  constructor() {
    super(
      "AI chat is not configured. Set LLM_BASE_URL (and LLM_API_KEY, LLM_MODEL) in the backend .env and restart.",
    );
    this.name = "LlmNotConfiguredError";
  }
}

export function isLlmConfigured(): boolean {
  return readLlmConfig().configured;
}

// Created on first use, not when this file loads, so missing or
// empty LLM settings can no longer crash the backend at startup.
let client: OpenAI | null = null;

// The SDK's own default is 10 minutes per request. Good Morning has only
// a 30-minute window, and a hung AI server would keep it from ever
// falling back to a built-in quote. The SDK still retries a failed
// request itself, exactly as before.
export const LLM_TIMEOUT_MS = 60_000;

// Some providers/models reject `reasoning_effort`. If that happens once,
// stop sending it (the quote is then generated exactly the same way,
// just without that hint).
let reasoningEffortSupported = true;

function getOpenAI(): OpenAI {
  const config = readLlmConfig();

  if (!config.configured) {
    throw new LlmNotConfiguredError();
  }

  client ??= new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: LLM_TIMEOUT_MS,
  });

  return client;
}

function getModel(): string {
  return readLlmConfig().model;
}

/**
 * Generates a simple response using the existing AIOS LLM configuration.
 *
 * This reuses the same OpenAI-compatible client and model
 * already used by AIOS Chat.
 */
export async function generateSimpleLLMResponse(
  prompt: string,
): Promise<string> {
  const request = {
    model: getModel(),
    messages: [
      {
        role: "system" as const,
        content:
          "You generate concise, professional workplace content for Intigate AIOS.",
      },
      {
        role: "user" as const,
        content: prompt,
      },
    ],
  };

  let response;

  try {
    response = await getOpenAI().chat.completions.create(
      reasoningEffortSupported
        ? { ...request, reasoning_effort: "minimal" }
        : request,
    );
  } catch (error) {
    if (
      !reasoningEffortSupported ||
      !isReasoningEffortRejected(error)
    ) {
      throw error;
    }

    reasoningEffortSupported = false;

    console.warn(
      "AI provider does not accept reasoning_effort; retrying the quote request without it.",
    );

    response = await getOpenAI().chat.completions.create(request);
  }

  return (
    response.choices[0]?.message?.content?.trim() ??
    ""
  );
}

// True for a 400/422 "bad request" that names reasoning_effort.
function isReasoningEffortRejected(error: unknown): boolean {
  const e = error as { status?: unknown; message?: unknown };

  return (
    (e?.status === 400 || e?.status === 422) &&
    /reasoning/i.test(String(e?.message ?? ""))
  );
}
