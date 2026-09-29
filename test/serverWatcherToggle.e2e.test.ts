// Starts the REAL backend (src/server.ts) as a separate process and
// checks TEAM_ACTIVITY_WATCHER_ENABLED / TEAM_ACTIVITY_POLL_INTERVAL_MS.
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

let fake: http.Server;
let fakePort = 0;
let timeTrackerHits = 0;

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    if (req.url?.startsWith("/tt")) {
      timeTrackerHits++;
      res.setHeader("content-type", "application/json");
      res.end("[]");
      return;
    }
    res.end("{}");
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
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-server-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${fakePort}`;
  timeTrackerHits = 0;
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
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout!.on("data", (d) => (logs += d));
  proc.stderr!.on("data", (d) => (logs += d));

  const until = Date.now() + 45_000; // generous: several test servers may start at once
  while (Date.now() < until) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return port;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`backend did not start\n${logs}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("10/11. TEAM_ACTIVITY_WATCHER_ENABLED", () => {
  it("disabled → service runs (/health OK), watcher never polls Time Tracker", async () => {
    const port = await startBackend({ TEAM_ACTIVITY_WATCHER_ENABLED: "false" });

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);

    await sleep(3_000);
    expect(timeTrackerHits).toBe(0); // no background polling
    expect(logs).toContain("Team Activity watcher is DISABLED");
    expect(fs.existsSync(path.join(workDir, "state"))).toBe(false);
  }, 40_000);

  it("enabled (default) → watcher runs, polls every 15 s by default", async () => {
    await startBackend({});
    await sleep(2_000);
    expect(timeTrackerHits).toBe(1); // immediate first poll only
    expect(logs).toContain("polling every 15s");
    expect(fs.existsSync(path.join(workDir, "state"))).toBe(true);
  }, 40_000);

  it("custom interval is honoured", async () => {
    await startBackend({ TEAM_ACTIVITY_POLL_INTERVAL_MS: "5000" });
    await sleep(5_800);
    expect(timeTrackerHits).toBe(2);
    expect(logs).toContain("polling every 5s");
  }, 40_000);
});
