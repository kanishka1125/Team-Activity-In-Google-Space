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
// Unallocated resources (12 PM report, Team Activity space only)
//
//   KEKA_BASE_URL, KEKA_CLIENT_ID, KEKA_CLIENT_SECRET, KEKA_API_KEY
//     Keka (read-only): the list of current employees.
//   KEKA_AUTH_URL                   default https://login.keka.com/connect/token
//   PMS_TASKS_API_URL, PMS_API_KEY  PMS tasks (read-only).
//   UNALLOCATED_ENABLED             true (default) | false
//   UNALLOCATED_CHECK_HOUR          default 12 (India time, 0-23)
//   UNALLOCATED_LATEST_HOUR         default 15: not sent after this hour
//                                   (a restart later in the day does not
//                                   post a stale "12 PM" report)
//   UNALLOCATED_EXCLUDED_EMAILS     comma-separated company emails that
//                                   are never listed (founders/leadership)
//   UNALLOCATED_EMAIL_ALIASES       other@x=keka@x,... for a person whose
//                                   Time Tracker / PMS email differs from
//                                   the one in Keka (explicit, never guessed)
//
// The report is ON only when every Keka/PMS setting is present, so an
// existing deployment without them keeps working unchanged.
// ---------------------------------------------------------------

export const UNALLOCATED_REQUIRED_SETTINGS = [
  "KEKA_BASE_URL",
  "KEKA_CLIENT_ID",
  "KEKA_CLIENT_SECRET",
  "KEKA_API_KEY",
  "PMS_TASKS_API_URL",
  "PMS_API_KEY",
] as const;

export const DEFAULT_KEKA_AUTH_URL =
  "https://login.keka.com/connect/token";

export interface UnallocatedConfig {
  enabled: boolean;
  // Why it is off (names of settings only, never values).
  reason: string | null;
  checkHour: number;
  latestHour: number;
  excludedEmails: string[];
  // other email → the email Keka has for the same person.
  emailAliases: Record<string, string>;
  warnings: string[];
}

const EMAIL_PATTERN = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;

export function normaliseEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function readUnallocatedConfig(
  env: NodeJS.ProcessEnv = process.env,
): UnallocatedConfig {
  const warnings: string[] = [];

  const hour = (name: string, fallback: number): number => {
    const raw = (env[name] ?? "").trim();

    if (raw === "") {
      return fallback;
    }

    const parsed = Number(raw);

    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) {
      warnings.push(
        `${name}="${raw}" is not an hour from 0 to 23; using ${fallback}.`,
      );
      return fallback;
    }

    return parsed;
  };

  const checkHour = hour("UNALLOCATED_CHECK_HOUR", 12);
  let latestHour = hour("UNALLOCATED_LATEST_HOUR", 15);

  if (latestHour < checkHour) {
    warnings.push(
      "UNALLOCATED_LATEST_HOUR is before UNALLOCATED_CHECK_HOUR; using 3 hours after the check hour.",
    );
    latestHour = Math.min(23, checkHour + 3);
  }

  const excludedEmails: string[] = [];

  for (const part of (env.UNALLOCATED_EXCLUDED_EMAILS ?? "")
    .split(/[,;\s]+/)
    .map(normaliseEmail)
    .filter(Boolean)) {
    if (EMAIL_PATTERN.test(part)) {
      if (!excludedEmails.includes(part)) {
        excludedEmails.push(part);
      }
    } else {
      warnings.push(
        `UNALLOCATED_EXCLUDED_EMAILS has an entry that is not an email address; it was ignored.`,
      );
    }
  }

  const emailAliases: Record<string, string> = {};

  for (const pair of (env.UNALLOCATED_EMAIL_ALIASES ?? "")
    .split(/[,;\s]+/)
    .filter(Boolean)) {
    const [from, to, ...rest] = pair.split("=").map(normaliseEmail);

    if (
      rest.length === 0 &&
      from &&
      to &&
      from !== to &&
      EMAIL_PATTERN.test(from) &&
      EMAIL_PATTERN.test(to)
    ) {
      emailAliases[from] = to;
    } else {
      warnings.push(
        "UNALLOCATED_EMAIL_ALIASES has an entry that is not in the form other@x=keka@x; it was ignored.",
      );
    }
  }

  const base = {
    checkHour,
    latestHour,
    excludedEmails,
    emailAliases,
    warnings,
  };

  const switchedOn = parseBooleanSetting(
    env.UNALLOCATED_ENABLED,
    true,
  );

  if (switchedOn === undefined) {
    warnings.push(
      `UNALLOCATED_ENABLED="${env.UNALLOCATED_ENABLED}" is not true/false; using the default (enabled when configured).`,
    );
  }

  if (switchedOn === false) {
    return {
      ...base,
      enabled: false,
      reason: "UNALLOCATED_ENABLED=false",
    };
  }

  const missing = UNALLOCATED_REQUIRED_SETTINGS.filter(
    (name) => !(env[name] ?? "").trim(),
  );

  if (missing.length > 0) {
    // Fully absent = feature simply not set up (no warning). Partly set
    // up is probably a mistake, so say which settings are missing.
    if (missing.length < UNALLOCATED_REQUIRED_SETTINGS.length) {
      warnings.push(
        `Unallocated resources report is OFF: missing ${missing.join(", ")}.`,
      );
    }

    return {
      ...base,
      enabled: false,
      reason: `not configured (missing ${missing.join(", ")})`,
    };
  }

  return { ...base, enabled: true, reason: null };
}
