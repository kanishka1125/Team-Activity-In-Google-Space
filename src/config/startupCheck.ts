import fs from "node:fs";
import path from "node:path";

import {
  getStateDir,
  getTeamActivityStateDir,
  readGoodMorningConfig,
  readLlmConfig,
  readTeamActivityWatcherConfig,
} from "./runtimeConfig.js";

// ---------------------------------------------------------------
// Startup configuration check.
//
// Reports, in one place and in plain words, exactly which settings
// are missing and what each one is needed for.
//
// - "blocking": the backend cannot start without it (the code reads
//   it while loading). The backend exits with a clear message
//   instead of a stack trace.
// - "missing": the backend starts, but the named feature won't work.
// - "warnings": optional features that are off, or odd values.
// ---------------------------------------------------------------

export interface MissingSetting {
  name: string;
  neededFor: string;
}

export interface StartupCheckResult {
  blocking: MissingSetting[];
  missing: MissingSetting[];
  problems: string[];
  warnings: string[];
}

const isSet = (env: NodeJS.ProcessEnv, name: string) =>
  (env[name] ?? "").trim() !== "";

export function checkStartupConfig(
  env: NodeJS.ProcessEnv = process.env,
): StartupCheckResult {
  const blocking: MissingSetting[] = [];
  const missing: MissingSetting[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];

  const need = (
    list: MissingSetting[],
    name: string,
    neededFor: string,
  ) => {
    if (!isSet(env, name)) {
      list.push({ name, neededFor });
    }
  };

  // Read while the service loads — it cannot start without this.
  // (Standalone Google Space service: no PMS settings are used.)
  need(blocking, "TIME_TRACKER_API_URL", "Time Tracker data and Team Activity");

  const teamActivity = readTeamActivityWatcherConfig(env);
  const goodMorning = readGoodMorningConfig(env);
  warnings.push(...teamActivity.warnings, ...goodMorning.warnings);

  if (teamActivity.enabled || goodMorning.enabled) {
    const features = [
      teamActivity.enabled ? "Team Activity" : "",
      goodMorning.enabled ? "Good Morning" : "",
    ]
      .filter(Boolean)
      .join(" and ");

    need(
      missing,
      "GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL",
      `${features} messages to Google Chat`,
    );
  }

  if (goodMorning.enabled) {
    need(missing, "GOOD_MORNING_IMAGE_URL", "the Good Morning message image");
  }

  if (!readLlmConfig(env).configured) {
    warnings.push(
      "AI is not configured (LLM_BASE_URL / LLM_API_KEY are empty): Good Morning will use built-in quotes.",
    );
  }

  // The state folder must be writable, or Team Activity can't record
  // what it has sent (and so won't send anything).
  const folders = new Set([getStateDir(env)]);

  if (teamActivity.enabled) {
    folders.add(getTeamActivityStateDir(env));
  }

  for (const folder of folders) {
    const problem = checkWritable(folder);

    if (problem) {
      problems.push(
        `State folder ${folder} is not usable (${problem}). Team Activity / Good Morning cannot save what they have sent. Set STATE_DIR to a writable folder.`,
      );
    }
  }

  return { blocking, missing, problems, warnings };
}

function checkWritable(folder: string): string | null {
  try {
    fs.mkdirSync(folder, { recursive: true });

    const probe = path.join(
      folder,
      `.write-check-${process.pid}.tmp`,
    );

    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });

    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ?? (error instanceof Error ? error.message : String(error));
  }
}

// Human-readable report, one line per item.
export function formatStartupReport(
  result: StartupCheckResult,
): string[] {
  const lines: string[] = [];

  for (const item of result.blocking) {
    lines.push(
      `  ✖ ${item.name} is missing — required to start the backend (needed for ${item.neededFor}).`,
    );
  }

  for (const item of result.missing) {
    lines.push(
      `  ✖ ${item.name} is missing — ${item.neededFor} will not work.`,
    );
  }

  for (const problem of result.problems) {
    lines.push(`  ✖ ${problem}`);
  }

  for (const warning of result.warnings) {
    lines.push(`  ⚠ ${warning}`);
  }

  return lines;
}
