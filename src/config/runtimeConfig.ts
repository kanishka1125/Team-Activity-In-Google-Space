import path from "node:path";

// ---------------------------------------------------------------
// Runtime settings read from environment variables (.env).
//
// This module deliberately imports nothing else from the app, so it
// can be used by the startup check before any service is loaded.
// ---------------------------------------------------------------

// true/false style values. Returns `fallback` when unset/empty and
// `undefined` when the value is not recognised.
export function parseBooleanSetting(
  value: string | undefined,
  fallback: boolean,
): boolean | undefined {
  const raw = (value ?? "").trim().toLowerCase();

  if (raw === "") {
    return fallback;
  }

  if (["true", "1", "yes", "on"].includes(raw)) {
    return true;
  }

  if (["false", "0", "no", "off"].includes(raw)) {
    return false;
  }

  return undefined;
}

// ---------------------------------------------------------------
// STATE_DIR — one folder for all persistent state files.
//
// When unset, files stay where they always were: the folder the
// backend is started from (process.cwd()).
//
//   <STATE_DIR>/team-activity-state/activity-state.json  (+ the two CSV copies)
//   <STATE_DIR>/.team-activity-leave-state.json   (legacy, read only)
//   <STATE_DIR>/.good-morning-state.json
//   <STATE_DIR>/.good-morning-quote-state.json
//
// TEAM_ACTIVITY_STATE_DIR, if set, still overrides the Team Activity
// folder only.
// ---------------------------------------------------------------

export function getStateDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.resolve(env.STATE_DIR?.trim() || process.cwd());
}

export function resolveStatePath(
  fileName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getStateDir(env), fileName);
}

export function getTeamActivityStateDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.TEAM_ACTIVITY_STATE_DIR?.trim();

  return override
    ? path.resolve(override)
    : resolveStatePath("team-activity-state", env);
}

// ---------------------------------------------------------------
// Team Activity watcher
//
//   TEAM_ACTIVITY_WATCHER_ENABLED   true (default) | false
//   TEAM_ACTIVITY_POLL_INTERVAL_MS  default 15000, minimum 5000
// ---------------------------------------------------------------

export const DEFAULT_TEAM_ACTIVITY_POLL_INTERVAL_MS = 15_000;
const MIN_TEAM_ACTIVITY_POLL_INTERVAL_MS = 5_000;

export interface TeamActivityWatcherConfig {
  enabled: boolean;
  intervalMs: number;
  // Problems with the configured values (defaults were used).
  warnings: string[];
}

export function readTeamActivityWatcherConfig(
  env: NodeJS.ProcessEnv = process.env,
): TeamActivityWatcherConfig {
  const warnings: string[] = [];

  let enabled = parseBooleanSetting(
    env.TEAM_ACTIVITY_WATCHER_ENABLED,
    true,
  );

  if (enabled === undefined) {
    warnings.push(
      `TEAM_ACTIVITY_WATCHER_ENABLED="${env.TEAM_ACTIVITY_WATCHER_ENABLED}" is not true/false; using the default (enabled).`,
    );
    enabled = true;
  }

  let intervalMs = DEFAULT_TEAM_ACTIVITY_POLL_INTERVAL_MS;
  const rawInterval = (
    env.TEAM_ACTIVITY_POLL_INTERVAL_MS ?? ""
  ).trim();

  if (rawInterval !== "") {
    const parsed = Number(rawInterval);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      warnings.push(
        `TEAM_ACTIVITY_POLL_INTERVAL_MS="${rawInterval}" is not a valid number; using ${DEFAULT_TEAM_ACTIVITY_POLL_INTERVAL_MS} ms.`,
      );
    } else if (parsed < MIN_TEAM_ACTIVITY_POLL_INTERVAL_MS) {
      warnings.push(
        `TEAM_ACTIVITY_POLL_INTERVAL_MS=${rawInterval} is too low; using the minimum ${MIN_TEAM_ACTIVITY_POLL_INTERVAL_MS} ms.`,
      );
      intervalMs = MIN_TEAM_ACTIVITY_POLL_INTERVAL_MS;
    } else {
      intervalMs = Math.round(parsed);
    }
  }

  return { enabled, intervalMs, warnings };
}

// ---------------------------------------------------------------
// Good Morning
//
//   GOOD_MORNING_ENABLED   true (default) | false
//     Like the Team Activity watcher, only ONE backend instance
//     should send Good Morning messages.
// ---------------------------------------------------------------

export interface GoodMorningConfig {
  enabled: boolean;
  warnings: string[];
}

export function readGoodMorningConfig(
  env: NodeJS.ProcessEnv = process.env,
): GoodMorningConfig {
  const enabled = parseBooleanSetting(
    env.GOOD_MORNING_ENABLED,
    true,
  );

  if (enabled === undefined) {
    return {
      enabled: true,
      warnings: [
        `GOOD_MORNING_ENABLED="${env.GOOD_MORNING_ENABLED}" is not true/false; using the default (enabled).`,
      ],
    };
  }

  return { enabled, warnings: [] };
}

// ---------------------------------------------------------------
// AI / LLM (OpenAI-compatible API)
//
//   LLM_BASE_URL  e.g. https://api.openai.com/v1 or
//                 http://localhost:11434/v1 for a local Ollama
//   LLM_API_KEY
//   LLM_MODEL     default "llama3.1"
//
// The AI is "configured" when LLM_BASE_URL or LLM_API_KEY has a
// value. Empty values (LLM_API_KEY="") count as not set.
// ---------------------------------------------------------------

export interface LlmConfig {
  configured: boolean;
  apiKey: string;
  baseURL: string;
  model: string;
}

export function readLlmConfig(
  env: NodeJS.ProcessEnv = process.env,
): LlmConfig {
  const apiKey = env.LLM_API_KEY?.trim() ?? "";
  const baseURL = env.LLM_BASE_URL?.trim() ?? "";
  const model = env.LLM_MODEL?.trim() ?? "";

  return {
    configured: apiKey !== "" || baseURL !== "",
    // Same defaults as before, used when only one value is given.
    apiKey: apiKey || "ollama",
    baseURL: baseURL || "http://localhost:11434/v1",
    model: model || "llama3.1",
  };
}

// ---------------------------------------------------------------
// Keka (read-only): the employee list and leave requests.
//
//   KEKA_BASE_URL, KEKA_CLIENT_ID, KEKA_CLIENT_SECRET, KEKA_API_KEY
//   KEKA_AUTH_URL   default https://login.keka.com/connect/token
//
// Leave from Keka is used only when the four settings above are present.
// ---------------------------------------------------------------

export const DEFAULT_KEKA_AUTH_URL =
  "https://login.keka.com/connect/token";

export function normaliseEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}
