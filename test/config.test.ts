import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getStateDir,
  getTeamActivityStateDir,
  readGoodMorningConfig,
  readLlmConfig,
  resolveStatePath,
} from "../src/config/runtimeConfig.js";
import {
  checkStartupConfig,
  formatStartupReport,
} from "../src/config/startupCheck.js";

// Modules imported below read these while loading; tests use fakes.
for (const name of ["TIME_TRACKER_API_URL"]) {
  process.env[name] ||= "http://127.0.0.1:9/unused";
}

let dir: string;
const saved = { ...process.env };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ["STATE_DIR", "TEAM_ACTIVITY_STATE_DIR", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const fullEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  TIME_TRACKER_API_URL: "https://tt",
  GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL: "https://chat",
  GOOD_MORNING_IMAGE_URL: "https://img",
  LLM_BASE_URL: "https://llm",
  LLM_API_KEY: "key",
  STATE_DIR: dir,
  ...extra,
});

// ---------------------------------------------------------------
describe("1. STATE_DIR", () => {
  it("unset → same locations as before (the folder the backend starts from)", () => {
    expect(getStateDir({})).toBe(process.cwd());
    expect(getTeamActivityStateDir({})).toBe(path.join(process.cwd(), "team-activity-state"));
    expect(resolveStatePath(".good-morning-state.json", {})).toBe(path.join(process.cwd(), ".good-morning-state.json"));
  });

  it("set → every state file goes under it", () => {
    const env = { STATE_DIR: dir };
    expect(getTeamActivityStateDir(env)).toBe(path.join(dir, "team-activity-state"));
    expect(resolveStatePath(".good-morning-state.json", env)).toBe(path.join(dir, ".good-morning-state.json"));
    expect(resolveStatePath(".good-morning-quote-state.json", env)).toBe(path.join(dir, ".good-morning-quote-state.json"));
    expect(resolveStatePath(".team-activity-leave-state.json", env)).toBe(path.join(dir, ".team-activity-leave-state.json"));
  });

  it("TEAM_ACTIVITY_STATE_DIR still overrides the Team Activity folder only", () => {
    const other = path.join(dir, "ta");
    expect(getTeamActivityStateDir({ STATE_DIR: dir, TEAM_ACTIVITY_STATE_DIR: other })).toBe(other);
  });

  it("Team Activity, Good Morning and quote files are really written to STATE_DIR (folder created if missing)", async () => {
    const stateDir = path.join(dir, "nested", "state");
    process.env.STATE_DIR = stateDir;
    delete process.env.TEAM_ACTIVITY_STATE_DIR;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { TeamActivityWatcherService } = await import("../src/services/teamActivityWatcher.service.js");
    const w = new TeamActivityWatcherService({
      activitySource: { getActivity: async () => [] },
      chat: { sendTeamActivityMessage: async () => {} },
    });
    await w.check();
    expect(fs.readdirSync(path.join(stateDir, "team-activity-state")).some((f) => f.endsWith(".json"))).toBe(true);

    // Good Morning with its REAL default state file and REAL quote service
    // (AI not configured → built-in quote), at 9:30 IST on a Thursday.
    const { GoodMorningWatcherService } = await import("../src/services/goodMorningWatcher.service.js");
    const sent: string[] = [];
    const gm = new GoodMorningWatcherService({
      now: () => new Date("2026-09-24T04:00:00Z"),
      sendMessage: async (m) => void sent.push(m),
    });
    await gm.check();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Good Morning Team☀️\n\n.+/);
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, ".good-morning-state.json"), "utf-8")).lastSentDate).toBe("2026-09-24");
    expect(fs.existsSync(path.join(stateDir, ".good-morning-quote-state.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------
describe("2. GOOD_MORNING_ENABLED", () => {
  it("defaults to enabled", () => {
    expect(readGoodMorningConfig({})).toEqual({ enabled: true, warnings: [] });
    expect(readGoodMorningConfig({ GOOD_MORNING_ENABLED: "" }).enabled).toBe(true);
  });

  it("can be turned off / on", () => {
    for (const v of ["false", "0", "no", "off", "FALSE"]) expect(readGoodMorningConfig({ GOOD_MORNING_ENABLED: v }).enabled).toBe(false);
    for (const v of ["true", "1", "yes", "on"]) expect(readGoodMorningConfig({ GOOD_MORNING_ENABLED: v }).enabled).toBe(true);
  });

  it("unrecognised value → enabled, with a warning", () => {
    const c = readGoodMorningConfig({ GOOD_MORNING_ENABLED: "nope" });
    expect(c.enabled).toBe(true);
    expect(c.warnings[0]).toContain("GOOD_MORNING_ENABLED");
  });
});

// ---------------------------------------------------------------
describe("3. empty LLM configuration", () => {
  it("empty strings (like the current .env) → not configured", () => {
    expect(readLlmConfig({ LLM_API_KEY: "", LLM_BASE_URL: "", LLM_MODEL: "" }).configured).toBe(false);
    expect(readLlmConfig({}).configured).toBe(false);
  });

  it("any of base URL / key set → configured, with the previous defaults for the rest", () => {
    expect(readLlmConfig({ LLM_BASE_URL: "http://localhost:11434/v1" })).toEqual({
      configured: true,
      apiKey: "ollama",
      baseURL: "http://localhost:11434/v1",
      model: "llama3.1",
    });
    expect(readLlmConfig({ LLM_API_KEY: "k", LLM_MODEL: "" }).model).toBe("llama3.1");
  });

  it("quote AI helper loads without credentials and reports 'not configured' (no network call)", async () => {
    process.env.LLM_API_KEY = "";
    process.env.LLM_BASE_URL = "";
    const llm = await import("../src/services/quoteLlm.js");
    expect(llm.isLlmConfigured()).toBe(false);
    await expect(llm.generateSimpleLLMResponse("x")).rejects.toBeInstanceOf(llm.LlmNotConfiguredError);
  });

  it("quote service uses a built-in quote without error spam when AI is not configured", async () => {
    process.env.LLM_API_KEY = "";
    process.env.LLM_BASE_URL = "";
    process.env.STATE_DIR = dir;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.resetModules();
    const { quoteService } = await import("../src/services/quote.service.js");
    const quote = await quoteService.getDailyQuote();
    expect(quote.quote.length).toBeGreaterThan(15);
    expect(errors).not.toHaveBeenCalled();
    // Same quote on retry (Good Morning retries reuse it).
    expect((await quoteService.getDailyQuote()).quote).toBe(quote.quote);
  });
});

// ---------------------------------------------------------------
describe("4. startup configuration check", () => {
  it("everything set → nothing reported", () => {
    const r = checkStartupConfig(fullEnv());
    expect(r).toEqual({ blocking: [], missing: [], problems: [], warnings: [] });
    expect(formatStartupReport(r)).toEqual([]);
  });

  it("names exactly which settings are missing", () => {
    const env = fullEnv();
    for (const k of ["TIME_TRACKER_API_URL", "GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL", "GOOD_MORNING_IMAGE_URL"]) delete env[k];
    const r = checkStartupConfig(env);
    expect(r.blocking.map((m) => m.name)).toEqual(["TIME_TRACKER_API_URL"]);
    expect(r.missing.map((m) => m.name)).toEqual([
      "GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL",
      "GOOD_MORNING_IMAGE_URL",
    ]);
    const report = formatStartupReport(r).join("\n");
    expect(report).toContain("TIME_TRACKER_API_URL is missing — required to start the backend");
    expect(report).toContain("GOOD_MORNING_IMAGE_URL is missing — the Good Morning message image will not work.");
  });

  it("empty / whitespace values count as missing", () => {
    const r = checkStartupConfig(fullEnv({ GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL: "", GOOD_MORNING_IMAGE_URL: "   " }));
    expect(r.missing.map((m) => m.name)).toEqual(["GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL", "GOOD_MORNING_IMAGE_URL"]);
  });

  it("Good Morning disabled → image not required; both disabled → webhook not required", () => {
    const env = fullEnv({ GOOD_MORNING_ENABLED: "false" });
    delete env.GOOD_MORNING_IMAGE_URL;
    expect(checkStartupConfig(env).missing).toEqual([]);

    delete env.GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL;
    env.TEAM_ACTIVITY_WATCHER_ENABLED = "false";
    expect(checkStartupConfig(env).missing).toEqual([]);
  });

  it("webhook message names the features that need it", () => {
    const env = fullEnv({ GOOD_MORNING_ENABLED: "false" });
    delete env.GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL;
    expect(checkStartupConfig(env).missing[0]!.neededFor).toBe("Team Activity messages to Google Chat");
  });

  it("empty LLM settings → a warning, not an error", () => {
    const r = checkStartupConfig(fullEnv({ LLM_API_KEY: "", LLM_BASE_URL: "" }));
    expect(r.blocking).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.warnings[0]).toContain("AI is not configured");
  });

  it("unusable STATE_DIR is reported", () => {
    const file = path.join(dir, "a-file");
    fs.writeFileSync(file, "x");
    const r = checkStartupConfig(fullEnv({ STATE_DIR: file }));
    expect(r.problems[0]).toContain(`State folder ${file}`);
    expect(r.problems[0]).toContain("Set STATE_DIR to a writable folder");
  });

  it("invalid on/off values are reported", () => {
    const r = checkStartupConfig(fullEnv({ TEAM_ACTIVITY_WATCHER_ENABLED: "maybe", GOOD_MORNING_ENABLED: "sure" }));
    expect(r.warnings.join(" ")).toContain("TEAM_ACTIVITY_WATCHER_ENABLED");
    expect(r.warnings.join(" ")).toContain("GOOD_MORNING_ENABLED");
  });
});
