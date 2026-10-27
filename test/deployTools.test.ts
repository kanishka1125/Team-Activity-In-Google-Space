// New in the final deploy: .env beats machine settings, /health shows the
// running build + image, and restart-now.txt restarts without server access.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { RestartFlagWatcher, RESTART_FLAG_FILE } from "../src/services/restartFlag.service.js";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("RestartFlagWatcher (unit)", () => {
  it("restarts once when restart-now.txt appears, and deletes the file first", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flag-"));
    const onRestart = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const w = new RestartFlagWatcher({ directory: dir, onRestart });

    w.check(); // nothing there
    expect(onRestart).not.toHaveBeenCalled();

    fs.writeFileSync(path.join(dir, RESTART_FLAG_FILE), "");
    w.check();
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(dir, RESTART_FLAG_FILE))).toBe(false);

    w.check(); // file gone → no second restart
    expect(onRestart).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a flag already present at start-up is removed and does NOT restart (no restart loop)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flag-"));
    const onRestart = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});
    fs.writeFileSync(path.join(dir, RESTART_FLAG_FILE), "");

    const w = new RestartFlagWatcher({ directory: dir, onRestart, pollMs: 20 });
    w.start();
    expect(fs.existsSync(path.join(dir, RESTART_FLAG_FILE))).toBe(false);
    w.check();
    expect(onRestart).not.toHaveBeenCalled();

    w.stop();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("if the flag cannot be deleted the service does NOT restart (it would restart forever)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flag-"));
    const onRestart = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A directory with that name exists but unlinkSync fails on it.
    fs.mkdirSync(path.join(dir, RESTART_FLAG_FILE));

    const w = new RestartFlagWatcher({ directory: dir, onRestart });
    w.check();
    w.check();

    expect(onRestart).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1); // warned once, not every poll

    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("real backend: .env wins, /health shows build, restart-now.txt restarts", () => {
  let fake: http.Server;
  let base = "";
  let proc: ChildProcess | null = null;
  let workDir = "";
  let logs = "";

  beforeAll(async () => {
    fake = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(req.url?.startsWith("/tt") ? "[]" : "{}");
      });
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    fake.closeAllConnections();
    await new Promise((r) => fake.close(r));
  });

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

  async function start(machineEnv: Record<string, string> = {}) {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-deploy-"));
    const port = await freePort();
    fs.writeFileSync(
      path.join(workDir, ".env"),
      [
        `PORT=${port}`,
        `TIME_TRACKER_API_URL=${base}/tt`,
        `GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL=${base}/chat`,
        `GOOD_MORNING_IMAGE_URL=${base}/NEW-image.png`,
        `STATE_DIR=${path.join(workDir, "state")}`,
        "TEAM_ACTIVITY_POLL_INTERVAL_MS=5000",
        "GOOD_MORNING_ENABLED=false",
      ].join("\n"),
    );
    logs = "";
    proc = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), serverEntry], {
      cwd: workDir,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...machineEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout!.on("data", (d) => (logs += d));
    proc.stderr!.on("data", (d) => (logs += d));

    const until = Date.now() + 45_000;
    while (Date.now() < until) {
      if (proc.exitCode !== null) throw new Error(`backend exited\n${logs}`);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) return { port, health: (await res.json()) as Record<string, unknown> };
      } catch {
        // not up yet
      }
      await sleep(100);
    }
    throw new Error(`backend did not start\n${logs}`);
  }

  it("a leftover machine setting does NOT beat .env (the old-image problem)", async () => {
    const { health } = await start({ GOOD_MORNING_IMAGE_URL: "http://old.example/OLD-image.png" });

    expect(health.goodMorningImageUrl).toBe(`${base}/NEW-image.png`);
    expect(logs).toContain("replaced by the values in .env: GOOD_MORNING_IMAGE_URL");
    expect(logs).not.toContain("OLD-image"); // names only, never values
  }, 60_000);

  it("/health reports the build, when it started and the image in use", async () => {
    const { health } = await start();

    expect(health.status).toBe("ok");
    expect(typeof health.build).toBe("string");
    expect(Number.isNaN(Date.parse(String(health.startedAt)))).toBe(false);
    expect(health.goodMorningImageUrl).toBe(`${base}/NEW-image.png`);
    expect(logs).toContain("Build ");
  }, 60_000);

  it("uploading restart-now.txt stops the service cleanly (exit 0) and removes the file", async () => {
    await start();
    const flag = path.join(workDir, "state", RESTART_FLAG_FILE);
    fs.mkdirSync(path.dirname(flag), { recursive: true });

    const exited = new Promise<number | null>((r) => proc!.once("exit", (code) => r(code)));
    fs.writeFileSync(flag, "");

    const code = await Promise.race([
      exited,
      sleep(30_000).then(() => "timeout" as const),
    ]);

    expect(code).toBe(0);
    expect(fs.existsSync(flag)).toBe(false);
    expect(logs).toContain("restart-now.txt found");
    expect(logs).toContain("Restart requested: finishing the current send, then stopping.");
  }, 60_000);
});
