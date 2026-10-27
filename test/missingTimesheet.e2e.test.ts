// Starts the REAL service (src/server.ts) as a separate process and checks
// that the Missing Timesheet schedule is OFF by default and refuses an unsafe
// destination. It never enables the schedule against a real Google Space.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "..", "src", "server.ts");

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

let fake: http.Server;
let fakePort = 0;

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(req.url?.startsWith("/tt") ? "[]" : "{}");
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakePort = (fake.address() as { port: number }).port;
});

afterAll(async () => {
  fake.closeAllConnections();
  await new Promise((r) => fake.close(r));
});

let proc: ChildProcess | null = null;
let workDir = "";
let logs = "";

afterEach(async () => {
  if (proc) {
    const p = proc;
    proc = null;
    const exited = new Promise((r) => p.once("exit", r));
    p.kill("SIGKILL");
    await exited;
  }
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

async function startBackend(extraEnv: Record<string, string>) {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "missing-ts-e2e-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${fakePort}`;
  logs = "";

  proc = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), serverEntry], {
    cwd: workDir,
    env: {
      ...process.env,
      PORT: String(port),
      TIME_TRACKER_API_URL: `${base}/tt`,
      GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL: `${base}/chat`,
      GOOD_MORNING_IMAGE_URL: `${base}/img.png`,
      TEAM_ACTIVITY_STATE_DIR: path.join(workDir, "state"),
      STATE_DIR: workDir,
      // Make sure nothing from the developer's own shell leaks in.
      MISSING_TIMESHEET_SCHEDULE_ENABLED: "",
      MISSING_TIMESHEET_WEBHOOK_URL: "",
      MISSING_TIMESHEET_POST_TO_MAIN_SPACE: "",
      MISSING_TIMESHEET_EXPECTED_SPACE_ID: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout!.on("data", (d) => (logs += d));
  proc.stderr!.on("data", (d) => (logs += d));

  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return { port, health: await res.json() };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`backend did not start\n${logs}`);
}

describe("Missing Timesheet in the running service", () => {
  it("is OFF by default: not scheduled, no state file, no PMS anywhere in /health", async () => {
    const { health } = await startBackend({});

    expect(health.missingTimesheet).toEqual({ scheduled: false });
    expect(JSON.stringify(health)).not.toMatch(/pms|freeResources/i);
    expect(logs).toContain("Missing Timesheet report: schedule OFF");
    expect(logs).not.toContain("Missing Timesheet watcher started");
    expect(fs.existsSync(path.join(workDir, ".missing-timesheet-state.json"))).toBe(false);
  }, 60_000);

  it("switched on but with no webhook: stays OFF and says why (the main Space is not used)", async () => {
    const { health } = await startBackend({ MISSING_TIMESHEET_SCHEDULE_ENABLED: "true" });

    expect(health.missingTimesheet.scheduled).toBe(false);
    expect(logs).toContain("no safe destination");
    expect(logs).toContain("MISSING_TIMESHEET_WEBHOOK_URL is not set");
    expect(logs).not.toContain("Missing Timesheet watcher started");
  }, 60_000);

  it("main Space switched on but its webhook is not a Google Chat webhook: refused, schedule stays OFF", async () => {
    const { health } = await startBackend({
      MISSING_TIMESHEET_SCHEDULE_ENABLED: "true",
      MISSING_TIMESHEET_POST_TO_MAIN_SPACE: "true",
    });

    expect(health.missingTimesheet.scheduled).toBe(false);
    expect(logs).toContain("GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL is not a Google Chat webhook URL");
    expect(logs).not.toContain("Missing Timesheet watcher started");
  }, 60_000);

  it("a destination that is not a Google Chat webhook is refused (schedule stays OFF)", async () => {
    const { health } = await startBackend({
      MISSING_TIMESHEET_SCHEDULE_ENABLED: "true",
      MISSING_TIMESHEET_WEBHOOK_URL: `http://127.0.0.1:${fakePort}/chat`,
    });

    expect(health.missingTimesheet.scheduled).toBe(false);
    expect(logs).toContain("not a Google Chat webhook URL");
  }, 60_000);
});
