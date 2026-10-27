// Reliability pass: Google Chat / AI time limits, malformed Time Tracker
// data, safe quote-history writes, CSV cell escaping, port conflict and
// clean shutdown. Everything else about the service is unchanged.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GoogleChatService } from "../src/integrations/googleChat/googleChat.service.js";
import { TimeTrackerClient } from "../src/integrations/timeTracker/timeTracker.client.js";
import { QuoteService } from "../src/services/quote.service.js";
import { TeamActivityStateStore, type TeamActivityRecord } from "../src/services/teamActivityState.store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "..", "src", "server.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------
// Fake HTTP server: /ok, /429, /hang, /rows-*, /chat-slow
// ---------------------------------------------------------------
let fake: http.Server;
let base = "";
let lastBody = "";
const stuck: http.ServerResponse[] = [];
let ttRows: unknown = [];
let slowChatHits = 0;

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastBody = body;
      if (req.url === "/hang") return void stuck.push(res);
      if (req.url === "/429") {
        res.statusCode = 429;
        return void res.end('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}');
      }
      if (req.url === "/tt") {
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify(ttRows));
      }
      if (req.url === "/chat-slow") {
        slowChatHits++;
        return void setTimeout(() => res.end("{}"), 1_500);
      }
      res.end("{}");
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(fake.address() as net.AddressInfo).port}`;
});

afterAll(async () => {
  stuck.forEach((r) => r.destroy());
  fake.closeAllConnections();
  await new Promise((r) => fake.close(r));
});

// ---------------------------------------------------------------
describe("Google Chat request time limit", () => {
  afterEach(() => {
    delete process.env.GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL;
    delete process.env.GOOD_MORNING_IMAGE_URL;
  });

  it("a stuck webhook gives up with a clear error instead of hanging", async () => {
    process.env.GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL = `${base}/hang`;
    const started = Date.now();
    await expect(new GoogleChatService(300).sendTeamActivityMessage("hi")).rejects.toThrow(
      "Google Chat webhook did not respond within",
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("the Good Morning card is limited too", async () => {
    process.env.GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL = `${base}/hang`;
    process.env.GOOD_MORNING_IMAGE_URL = `${base}/img.png`;
    await expect(new GoogleChatService(300).sendGoodMorningMessage("hi")).rejects.toThrow("did not respond");
  });

  it("successful sends: team activity is plain text, Good Morning card has a clickable image and a Download button", async () => {
    process.env.GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL = `${base}/ok`;
    process.env.GOOD_MORNING_IMAGE_URL = `${base}/img.png`;
    const chat = new GoogleChatService();

    await chat.sendTeamActivityMessage("🟢 Asha switched to X from Y at 10:45 AM");
    expect(JSON.parse(lastBody)).toEqual({ text: "🟢 Asha switched to X from Y at 10:45 AM" });

    await chat.sendGoodMorningMessage("Good Morning Team☀️\n\nquote");
    expect(JSON.parse(lastBody)).toEqual({
      text: "Good Morning Team☀️\n\nquote",
      cardsV2: [
        {
          cardId: "good-morning",
          card: {
            sections: [
              {
                widgets: [
                  {
                    image: {
                      imageUrl: `${base}/img.png`,
                      altText: "Good Morning Team",
                      onClick: { openLink: { url: `${base}/img.png` } },
                    },
                  },
                  {
                    buttonList: {
                      buttons: [{ text: "Download image", onClick: { openLink: { url: `${base}/img.png` } } }],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    });
  });

  it("a 429 still produces the error text the retry logic looks for", async () => {
    process.env.GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL = `${base}/429`;
    const error = await new GoogleChatService().sendTeamActivityMessage("x").catch((e: Error) => e);
    expect(String((error as Error).message)).toMatch(/^Google Chat webhook failed: 429 /);
    expect(/\b429\b/.test((error as Error).message)).toBe(true);
  });
});

// ---------------------------------------------------------------
describe("Time Tracker response shape", () => {
  it("a non-list answer (HTTP 200) gives a clear error", async () => {
    process.env.TIME_TRACKER_API_URL = `${base}/tt`;
    ttRows = { error: "Authorization required" };
    await expect(new TimeTrackerClient().getData()).rejects.toThrow("unexpected response (expected a list of rows)");
  });

  it("a normal list is returned as before", async () => {
    process.env.TIME_TRACKER_API_URL = `${base}/tt`;
    ttRows = [{ rowIndex: 2, name: "Asha" }];
    await expect(new TimeTrackerClient().getData()).resolves.toEqual([{ rowIndex: 2, name: "Asha" }]);
  });
});

// ---------------------------------------------------------------
// Malformed rows: one bad row must not stop the other rows.
// ---------------------------------------------------------------
const rows: Array<Record<string, unknown> | null> = [];
vi.mock("../src/integrations/timeTracker/timeTracker.service.js", () => ({
  TimeTrackerService: class {
    async getTimeEntries() {
      return rows.map((r) => (r ? { ...r } : r));
    }
  },
}));

const today = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
})
  .format(new Date())
  .replaceAll("/", "-");

function row(rowIndex: number, name: string, project: unknown, startTime: string, extra: Record<string, unknown> = {}) {
  return {
    rowIndex,
    name,
    email: `${name.toLowerCase()}@x.in`,
    project,
    note: "",
    startTime,
    endTime: "",
    dateSubmitted: today,
    totalHours: 0,
    isOnLeave: false,
    isAuto: false,
    actionBy: "",
    ...extra,
  };
}

describe("malformed Time Tracker rows", () => {
  beforeEach(() => {
    rows.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("null row, null/missing cells and a numeric project don't stop valid rows", async () => {
    const { TeamActivityService } = await import("../src/services/teamActivity.service.js");
    const service = new TeamActivityService();

    rows.push(row(2, "Asha", "Eureka", "9:30"));
    await service.getActivity();

    rows.push(
      null, // not a row at all
      row(3, "Ben", null, "10:00"), // project null
      row(4, "Cara", undefined, "10:05"), // project missing
      row(5, "Dev", 1234, "10:10"), // numeric project name
      { ...row(6, "Esha", "Suffix", "10:15"), email: null }, // email null
      row(7, "Asha", "Li3ib", "10:45"), // valid switch, after the bad rows
    );

    const events = await service.getActivity();
    const msg = (name: string) => events.find((e) => e.name === name)?.message;

    expect(msg("Asha")).toBe("Asha has started working on Eureka at 9:30 AM 😄");
    expect(events.find((e) => e.name === "Asha" && e.project === "Li3ib")?.message).toBe(
      "Asha switched to Li3ib from Eureka at 10:45 AM",
    );
    // Missing values are reported as "Unknown project", not invented.
    expect(msg("Ben")).toBe("Ben has started working on Unknown project at 10:00 AM 🙂");
    expect(msg("Dev")).toBe("Dev has started working on 1234 at 10:10 AM 🙂");
  });

  it("valid rows behave exactly as before", async () => {
    const { TeamActivityService } = await import("../src/services/teamActivity.service.js");
    const service = new TeamActivityService();
    rows.push(row(2, "Asha", "Eureka", "9:30"), row(3, "Asha", "Li3ib", "10:45"), row(4, "Lina", "", "", { isOnLeave: true }));
    const events = await service.getActivity();
    expect(events.map((e) => e.message)).toEqual([
      "Lina is on leave today",
      "Asha has started working on Eureka at 9:30 AM 😄",
      "Asha switched to Li3ib from Eureka at 10:45 AM",
    ]);
  });
});

// ---------------------------------------------------------------
describe("AI client options and reasoning_effort compatibility", () => {
  const created: Array<Record<string, unknown>> = [];
  const ctorOptions: Array<Record<string, unknown>> = [];
  let failFirstWith: unknown = null;

  beforeEach(() => {
    created.length = 0;
    ctorOptions.length = 0;
    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class {
        constructor(options: Record<string, unknown>) {
          ctorOptions.push(options);
        }
        chat = {
          completions: {
            create: async (req: Record<string, unknown>) => {
              created.push(req);
              if (failFirstWith && created.length === 1) throw failFirstWith;
              return { choices: [{ message: { content: ' {"quote":"ok"} ' } }] };
            },
          },
        };
      },
    }));
    process.env.LLM_API_KEY = "k";
    process.env.LLM_BASE_URL = "http://llm.test/v1";
    failFirstWith = null;
  });

  afterEach(() => {
    vi.doUnmock("openai");
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    vi.restoreAllMocks();
  });

  it("requests have a time limit; provider accepting reasoning_effort → still sent as before", async () => {
    const llm = await import("../src/services/quoteLlm.js");
    await expect(llm.generateSimpleLLMResponse("p")).resolves.toBe('{"quote":"ok"}');
    expect(ctorOptions[0]).toMatchObject({ timeout: llm.LLM_TIMEOUT_MS, baseURL: "http://llm.test/v1", apiKey: "k" });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ reasoning_effort: "minimal" });
  });

  it("provider rejects reasoning_effort → one retry without it, and not sent again afterwards", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    failFirstWith = Object.assign(new Error("400 Unsupported parameter: 'reasoning_effort'"), { status: 400 });
    const llm = await import("../src/services/quoteLlm.js");

    await expect(llm.generateSimpleLLMResponse("p")).resolves.toBe('{"quote":"ok"}');
    expect(created).toHaveLength(2);
    expect(created[0]).toHaveProperty("reasoning_effort");
    expect(created[1]).not.toHaveProperty("reasoning_effort");

    await llm.generateSimpleLLMResponse("p");
    expect(created).toHaveLength(3);
    expect(created[2]).not.toHaveProperty("reasoning_effort");
  });

  it("other errors are not swallowed (the quote service then falls back)", async () => {
    failFirstWith = Object.assign(new Error("500 server error"), { status: 500 });
    const llm = await import("../src/services/quoteLlm.js");
    await expect(llm.generateSimpleLLMResponse("p")).rejects.toThrow("500 server error");
    expect(created).toHaveLength(1);
  });
});

// ---------------------------------------------------------------
describe("quote history file", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "quote-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is written safely (valid JSON, no temp file left)", async () => {
    const file = path.join(dir, "q.json");
    const q = await new QuoteService({ stateFile: file, aiEnabled: () => false }).getDailyQuote();
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).usedQuotes).toHaveLength(1);
    expect(fs.readdirSync(dir)).toEqual(["q.json"]);
    expect(q.quote.length).toBeGreaterThan(10);
  });

  it("an unreadable history file is kept aside instead of being overwritten; a quote is still produced", async () => {
    const file = path.join(dir, "q.json");
    fs.writeFileSync(file, '{"dailyQuotes": {"2026-01-01": ');
    const q = await new QuoteService({ stateFile: file, aiEnabled: () => false }).getDailyQuote();

    expect(q.quote).toBeTruthy();
    const names = fs.readdirSync(dir).sort();
    expect(names.some((n) => n.startsWith("q.json.corrupt-"))).toBe(true);
    const kept = names.find((n) => n.startsWith("q.json.corrupt-"))!;
    expect(fs.readFileSync(path.join(dir, kept), "utf-8")).toContain("2026-01-01");
    expect(() => JSON.parse(fs.readFileSync(file, "utf-8"))).not.toThrow();
  });
});

// ---------------------------------------------------------------
describe("readable CSV copies", () => {
  it("values that would run as a spreadsheet formula are shown as text; normal values unchanged", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-"));
    try {
      const store = new TeamActivityStateStore(dir);
      const rec = (id: string, employee: string, toProject: string): TeamActivityRecord => ({
        activityId: id,
        type: "login",
        employee,
        email: "a@x.in",
        fromProject: null,
        toProject,
        timestamp: "10:44 AM",
        message: `🟢 ${employee} has started working on ${toProject} at 10:44 AM 🙁`,
        status: "sent",
        attempts: 0,
        lastError: null,
        nextAttemptAt: null,
        sendStartedAt: null,
        detectedAt: "2026-09-29T05:00:00.000Z",
        sentAt: "2026-09-29T05:00:05.000Z",
      });

      store.save({
        version: 1,
        date: "2026-09-29",
        records: [rec("a", "=HYPERLINK(1)", "-Internal"), rec("b", "Asha Rao", "KFH New, Phase 2")],
      });

      const csv = fs.readFileSync(path.join(dir, "sent-entries.csv"), "utf-8");
      expect(csv).toContain("'=HYPERLINK(1)");
      expect(csv).toContain("'-Internal");
      expect(csv).toContain("Asha Rao");
      expect(csv).toContain('"KFH New, Phase 2"');
      expect(csv).toContain("29-09-2026,10:44 AM");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------
// Real process: port conflict, /health, clean shutdown
// ---------------------------------------------------------------
describe("real backend", () => {
  let proc: ChildProcess | null = null;
  let workDir = "";
  let logs = "";

  afterEach(async () => {
    if (proc && proc.exitCode === null) {
      const p = proc;
      const exited = new Promise((r) => p.once("exit", r));
      p.kill("SIGKILL");
      await exited;
    }
    proc = null;
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  function start(port: number, chatPath: string, ttUrl = `${base}/tt`) {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rel-"));
    logs = "";
    fs.writeFileSync(
      path.join(workDir, ".env"),
      Object.entries({
        TIME_TRACKER_API_URL: ttUrl,
        GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL: `${base}${chatPath}`,
        GOOD_MORNING_ENABLED: "false",
        STATE_DIR: path.join(workDir, "state"),
        TEAM_ACTIVITY_POLL_INTERVAL_MS: "5000",
        PORT: String(port),
      })
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    );
    proc = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), serverEntry], {
      cwd: workDir,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout!.on("data", (d) => (logs += d));
    proc.stderr!.on("data", (d) => (logs += d));
    return proc;
  }

  const waitFor = async (check: () => boolean | Promise<boolean>, what: string, ms = 30_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await check()) return;
      await sleep(50);
    }
    throw new Error(`Timed out: ${what}\n${logs}`);
  };

  it("port already in use → exits with a clear message and never starts the watchers", async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, r));
    const port = (blocker.address() as net.AddressInfo).port;

    try {
      const p = start(port, "/ok");
      const code = await new Promise<number | null>((r) => p.once("exit", r));

      expect(code).toBe(1);
      expect(logs).toContain(`Cannot listen on port ${port}`);
      expect(logs).not.toContain("watcher started");
      expect(logs).not.toContain("service running on");
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  }, 60_000);

  it.skipIf(process.platform === "win32")("/health keeps status ok and adds Team Activity detail; SIGTERM lets the send in flight finish", async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise((r) => probe.close(r));

    const today2 = today;
    ttRows = [
      { rowIndex: 2, name: "Asha Rao", email: "asha@x.in", project: "Eureka", note: "", startTime: "9:30", endTime: "", dateSubmitted: today2, totalHours: 0, isOnLeave: false, isAuto: false, actionBy: "" },
    ];
    slowChatHits = 0;

    const p = start(port, "/chat-slow");
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {
        return false;
      }
    }, "backend up");

    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(health.status).toBe("ok");
    expect(health.service).toBe("intigate-google-space-team-activity");
    expect(health.teamActivity).toMatchObject({ running: true });

    await waitFor(() => logs.includes("watcher initialized"), "first poll");

    // New activity → the (slow) send starts → SIGTERM while it is in flight.
    (ttRows as unknown[]).push({ rowIndex: 3, name: "Asha Rao", email: "asha@x.in", project: "Li3ib", note: "", startTime: "10:45", endTime: "", dateSubmitted: today2, totalHours: 0, isOnLeave: false, isAuto: false, actionBy: "" });
    await waitFor(() => slowChatHits >= 1, "send started", 20_000);

    const exited = new Promise<number | null>((r) => p.once("exit", r));
    p.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(logs).toContain("SIGTERM received");

    const state = JSON.parse(fs.readFileSync(path.join(workDir, "state", "team-activity-state", "activity-state.json"), "utf-8"));
    const records = Object.values(state.days).flat() as TeamActivityRecord[];
    const sent = records.find((r) => r.toProject === "Li3ib");
    expect(sent?.status).toBe("sent"); // finished and recorded, so it is not posted again
    expect(sent?.sendStartedAt).toBeNull();
    expect(logs).not.toContain("interrupted by a restart");
  }, 90_000);
});
