// Starts the REAL backend (src/server.ts) from a folder containing a
// .env file, like `npm run dev` does locally, against fake Time
// Tracker / Google Chat servers.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

// Ask the OS for a port nobody is using (random ports could clash
// when several test files start servers at the same time).
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}
const serverEntry = path.resolve(here, "..", "src", "server.ts");

const today = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
})
  .format(new Date())
  .replaceAll("/", "-");

let rows: unknown[] = [];
let chatMessages: string[] = [];
let ttHits = 0;
let fake: http.Server;
let base = "";

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.startsWith("/tt")) {
        ttHits++;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(rows));
        return;
      }
      if (req.url?.startsWith("/chat")) {
        chatMessages.push(JSON.parse(body).text);
        res.end("{}");
        return;
      }
      res.end("{}");
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
});

afterAll(async () => {
  fake.closeAllConnections();
  await new Promise((r) => fake.close(r));
});

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

// Same shape as apps/backend/.env today (LLM_* present but empty).
function envFile(overrides: Record<string, string | null> = {}) {
  const values: Record<string, string | null> = {
    NODE_ENV: "development",
    TIME_TRACKER_API_URL: `${base}/tt`,
    GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL: `${base}/chat`,
    GOOD_MORNING_IMAGE_URL: `${base}/img.png`,
    LLM_BASE_URL: '""',
    LLM_MODEL: '""',
    LLM_API_KEY: '""',
    STATE_DIR: path.join(workDir, "state"),
    TEAM_ACTIVITY_POLL_INTERVAL_MS: "5000",
    ...overrides,
  };
  return Object.entries(values)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

async function startBackend(overrides: Record<string, string | null> = {}, waitForHealth = true) {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-start-"));
  const port = await freePort();
  fs.writeFileSync(path.join(workDir, ".env"), envFile({ PORT: String(port), ...overrides }));
  logs = "";
  ttHits = 0;
  chatMessages = [];

  proc = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), serverEntry], {
    cwd: workDir,
    // Only the basics: everything else comes from the .env file.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout!.on("data", (d) => (logs += d));
  proc.stderr!.on("data", (d) => (logs += d));

  if (!waitForHealth) return port;

  const until = Date.now() + 45_000; // generous: several test servers may start at once
  while (Date.now() < until) {
    if (proc.exitCode !== null) throw new Error(`backend exited\n${logs}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return port;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`backend did not start\n${logs}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (check: () => boolean, what: string, ms = 15_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${what}\n${logs}`);
};

function ttRow(rowIndex: number, name: string, project: string, startTime: string) {
  return {
    rowIndex, name, email: `${name.split(" ")[0]!.toLowerCase()}@x.in`, project, note: "",
    startTime, endTime: "", dateSubmitted: today, totalHours: 0, isOnLeave: false, isAuto: false, actionBy: "",
  };
}

describe("real backend startup", () => {
  it("empty LLM settings → service starts; Team Activity + Good Morning run (built-in quotes)", async () => {
    rows = [ttRow(2, "Asha Rao", "Eureka", "9:30")];
    const port = await startBackend();

    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);

    expect(logs).toContain("Startup configuration check: OK, with notes");
    expect(logs).toContain("AI is not configured");
    expect(logs).not.toContain("Missing credentials");
    expect(logs).toContain("Good Morning watcher started.");

    // Team Activity still works end-to-end: one new activity → one message.
    await waitFor(() => logs.includes("watcher initialized"), "watcher initialized");
    rows.push(ttRow(3, "Asha Rao", "Li3ib", "10:45"));
    await waitFor(() => chatMessages.length === 1, "Team Activity message", 12_000);
    await sleep(5_500); // another poll
    expect(chatMessages).toEqual(["🟢 Asha Rao switched to Li3ib from Eureka at 10:45 AM"]);

    // 1. State written under STATE_DIR.
    const stateDir = path.join(workDir, "state", "team-activity-state");
    expect(fs.readdirSync(stateDir).sort()).toEqual(["activity-state.json", "sent-entries.csv", "skipped-entries.csv"]);
    expect(fs.existsSync(path.join(workDir, "team-activity-state"))).toBe(false);
  }, 60_000);

  it("4. settings the backend can't start without → clear message, exit code 1, no stack trace", async () => {
    await startBackend({ TIME_TRACKER_API_URL: '""' }, false);
    const code = await new Promise<number | null>((r) => proc!.once("exit", r));

    expect(code).toBe(1);
    expect(logs).toContain("Startup configuration check FAILED — the backend was NOT started");
    expect(logs).toContain("TIME_TRACKER_API_URL is missing — required to start the backend");
    expect(logs).not.toMatch(/\n\s+at /); // no stack trace
  }, 60_000);

  it("4. feature settings missing → backend starts, each missing setting is named", async () => {
    const port = await startBackend({
      GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL: null,
      GOOD_MORNING_IMAGE_URL: '""',
    });
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    expect(logs).toContain("the backend is starting, but some features will not work");
    expect(logs).toContain("GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL is missing — Team Activity and Good Morning messages to Google Chat will not work.");
    expect(logs).toContain("GOOD_MORNING_IMAGE_URL is missing");
  }, 60_000);

  it("2. GOOD_MORNING_ENABLED=false → Good Morning off, API and Team Activity still run", async () => {
    const port = await startBackend({ GOOD_MORNING_ENABLED: "false", GOOD_MORNING_IMAGE_URL: null });
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    expect(logs).toContain("Good Morning is DISABLED on this instance");
    expect(logs).not.toContain("Good Morning watcher started.");
    expect(logs).not.toContain("GOOD_MORNING_IMAGE_URL is missing"); // not needed when off
    await waitFor(() => ttHits >= 1, "Team Activity polling");
  }, 60_000);

  it("everything configured → 'Startup configuration check: OK.'", async () => {
    await startBackend({ LLM_BASE_URL: `${base}/llm`, LLM_API_KEY: "k" });
    expect(logs).toContain("Startup configuration check: OK.");
  }, 60_000);
});
