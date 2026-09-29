// End-to-end crash/restart tests.
//
// Runs the REAL watcher (real TeamActivityService, TimeTrackerClient
// and GoogleChatService) in a separate Node process, pointed at local
// fake Time Tracker and Google Chat servers, and kills it with SIGKILL
// to simulate a server crash.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, "..");
const runner = path.join(here, "fixtures", "runWatcher.ts");

// ---------------------------------------------------------------
// Fake Time Tracker + Google Chat
// ---------------------------------------------------------------

type ChatMode = "ok" | "429" | "500" | "hang";

interface Row {
  rowIndex: number;
  name: string;
  email: string;
  project: string;
  note: string;
  startTime: string;
  endTime: string;
  dateSubmitted: string;
  totalHours: number;
  isOnLeave: boolean;
  isAuto: boolean;
  actionBy: string;
}

const today = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
})
  .format(new Date())
  .replaceAll("/", "-");

let rows: Row[] = [];
let chatMode: ChatMode = "ok";
// Per-request override queue, then falls back to chatMode.
let chatPlan: ChatMode[] = [];
let delivered: string[] = [];
let hanging: http.ServerResponse[] = [];
let server: http.Server;
let port = 0;

function renumber() {
  rows.forEach((r, i) => (r.rowIndex = 2 + i));
}

function row(name: string, project: string, startTime: string, leave = false): Row {
  return {
    rowIndex: 0,
    name,
    email: `${name.split(" ")[0]!.toLowerCase()}@intigate.test`,
    project,
    note: "",
    startTime,
    endTime: "",
    dateSubmitted: today,
    totalHours: 0,
    isOnLeave: leave,
    isAuto: false,
    actionBy: "",
  };
}

function addRows(...newRows: Row[]) {
  rows.push(...newRows);
  renumber();
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.startsWith("/tt")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(rows));
      return;
    }

    if (req.url?.startsWith("/chat")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const mode = chatPlan.shift() ?? chatMode;

        if (mode === "hang") {
          hanging.push(res);
          return;
        }

        if (mode === "429") {
          res.statusCode = 429;
          res.end('{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}');
          return;
        }

        if (mode === "500") {
          res.statusCode = 500;
          res.end('{"error":{"code":500}}');
          return;
        }

        delivered.push(JSON.parse(body).text);
        res.end("{}");
      });
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  hanging.forEach((r) => r.destroy());
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

// ---------------------------------------------------------------
// Watcher process control
// ---------------------------------------------------------------

let workDir: string;
let stateDir: string;
let proc: ChildProcess | null = null;
let logs = "";

function startWatcher() {
  proc = spawn(
    process.execPath,
    // Resolve tsx from the backend (the process runs in a temp dir).
    ["--import", import.meta.resolve("tsx"), runner],
    {
      cwd: workDir,
      env: {
        ...process.env,
        NODE_PATH: path.join(backendRoot, "node_modules"),
        TIME_TRACKER_API_URL: `http://127.0.0.1:${port}/tt`,
        GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL: `http://127.0.0.1:${port}/chat`,
        TEAM_ACTIVITY_STATE_DIR: stateDir,
        POLL_MS: "150",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  proc.stdout!.on("data", (d) => (logs += d));
  proc.stderr!.on("data", (d) => (logs += d));
}

async function crash() {
  if (!proc) return;
  const p = proc;
  proc = null;
  const exited = new Promise((r) => p.once("exit", r));
  p.kill("SIGKILL");
  await exited;
}

function state(): { records: Array<{ activityId: string; message: string; status: string; sendStartedAt: string | null; attempts: number }> } {
  const date = today.split("-").reverse().join("-");
  const file = path.join(stateDir, "activity-state.json");
  if (!fs.existsSync(file)) return { records: [] };
  return { records: JSON.parse(fs.readFileSync(file, "utf-8")).days?.[date] ?? [] };
}

const rec = (text: string) => state().records.find((r) => r.message.includes(text));

async function waitFor(check: () => boolean, what: string, ms = 15_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if (check()) return;
    } catch {
      // state file mid-write or not there yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for: ${what}\n--- watcher logs ---\n${logs}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (text: string) => delivered.filter((m) => m.includes(text)).length;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-e2e-"));
  stateDir = path.join(workDir, "team-activity-state");
  rows = [];
  chatMode = "ok";
  chatPlan = [];
  delivered = [];
  logs = "";
});

afterEach(async () => {
  await crash();
  hanging.forEach((r) => r.destroy());
  hanging = [];
  fs.rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------

describe("Team Activity watcher — real process crash/restart", () => {
  it("sent records are not replayed, pending records are recovered after a crash", async () => {
    // Existing activity when the server starts → not announced.
    addRows(row("Old Timer", "Eureka", "9:30"), row("Early Bird", "KFH Old", "9:35"));
    startWatcher();
    await waitFor(() => logs.includes("watcher initialized") && state().records.length === 2, "baseline recorded");
    expect(state().records.every((r) => r.status === "skipped")).toBe(true);

    // Three new activities: first two delivered, then Google Chat 429s.
    chatPlan = ["ok", "ok"];
    chatMode = "429";
    addRows(
      row("Asha Rao", "Li3ib", "10:40"),
      row("Ben Das", "RVVPL", "10:41"),
      row("Cara Sen", "Suffix", "10:42"),
    );
    await waitFor(
      () => rec("Asha")?.status === "sent" && rec("Ben")?.status === "sent" && (rec("Cara")?.attempts ?? 0) >= 1,
      "two sent, one failing with 429",
    );
    expect(rec("Cara")!.status).toBe("pending");

    await crash();
    // State survived the crash.
    expect(rec("Asha")!.status).toBe("sent");
    expect(rec("Cara")!.status).toBe("pending");

    // Restart with Google Chat healthy. Cara's 429 backoff is 5s.
    chatMode = "ok";
    startWatcher();
    await waitFor(() => rec("Cara")?.status === "sent", "pending record recovered", 20_000);
    await sleep(800);

    expect(count("Asha")).toBe(1);
    expect(count("Ben")).toBe(1);
    expect(count("Cara")).toBe(1);
    expect(count("Old Timer")).toBe(0);
    expect(count("Early Bird")).toBe(0);
  }, 40_000);

  it("restart after successful notification sends nothing again", async () => {
    startWatcher();
    await waitFor(() => logs.includes("watcher initialized"), "first poll done");
    addRows(row("Asha Rao", "Li3ib", "10:40"));
    await waitFor(() => rec("Asha")?.status === "sent", "sent");
    await crash();

    startWatcher();
    await sleep(1500); // ~10 polling cycles
    await crash();
    startWatcher();
    await sleep(1500);

    expect(count("Asha")).toBe(1);
  }, 30_000);

  it("restart before notification (crash while the send is in flight) → delivered after restart", async () => {
    startWatcher();
    await waitFor(() => logs.includes("watcher initialized"), "first poll done");
    chatMode = "hang";
    addRows(row("Dev Kumar", "Eureka", "11:02"));
    await waitFor(() => !!rec("Dev")?.sendStartedAt, "send in flight");
    await crash();
    expect(rec("Dev")!.status).toBe("pending");

    chatMode = "ok";
    startWatcher();
    await waitFor(() => rec("Dev")?.status === "sent", "recovered");
    expect(count("Dev")).toBe(1);
    expect(logs).toContain("interrupted by a restart");
  }, 30_000);

  it("Google Chat temporary failure (500) keeps the record pending until it succeeds", async () => {
    startWatcher();
    await waitFor(() => logs.includes("watcher initialized"), "first poll done");
    chatPlan = ["500"];
    addRows(row("Esha Jain", "KFH New", "11:10"));
    await waitFor(() => (rec("Esha")?.attempts ?? 0) >= 1, "first attempt failed");
    expect(rec("Esha")!.status).toBe("pending");
    await waitFor(() => rec("Esha")?.status === "sent", "retried and sent", 15_000);
    expect(count("Esha")).toBe(1);
  }, 30_000);

  it("row shift + duplicate Time Tracker rows → correct person, no re-send, one message each", async () => {
    // Mirrors this morning: a row ABOVE gets deleted, so every row
    // number below shifts by one while Jonish's entry is added.
    addRows(
      row("Zero Minute", "Li3ib", "10:30"),
      row("Ashwani Kushwaha", "Li3ib", "9:40"),
      row("Ashwani Kushwaha", "RVVPL", "10:38"),
    );
    startWatcher();
    await waitFor(() => logs.includes("watcher initialized") && state().records.length === 3, "baseline");

    rows.splice(0, 1); // delete a row above → shift
    addRows(row("Jonish Kumar", "KFH New", "10:44"));
    // Time Tracker returns the same entry twice.
    addRows({ ...rows[rows.length - 1]! });
    await waitFor(() => rec("Jonish")?.status === "sent", "Jonish sent");
    await sleep(800);

    expect(delivered.filter((m) => m.includes("Jonish"))).toEqual([
      "🟢 Jonish Kumar has started working on KFH New at 10:44 AM 🙁",
    ]);
    expect(delivered.some((m) => m.includes("from RVVPL"))).toBe(false);
    expect(count("Ashwani")).toBe(0);
  }, 30_000);

  it("server down → entries made meanwhile are posted after restart; CSV sheets written", async () => {
    addRows(row("Early Bird", "KFH Old", "9:20"));
    startWatcher();
    await waitFor(() => logs.includes("watcher initialized"), "first poll done");
    addRows(row("Asha Rao", "Li3ib", "10:40"));
    await waitFor(() => rec("Asha")?.status === "sent", "live activity sent");

    await crash(); // server down
    addRows(row("Ben Das", "RVVPL", "10:55"), row("Cara Sen", "Suffix", "11:20"));

    startWatcher(); // back up
    await waitFor(() => rec("Ben")?.status === "sent" && rec("Cara")?.status === "sent", "missed activity posted");
    await sleep(600);

    expect(count("Ben")).toBe(1);
    expect(count("Cara")).toBe(1);
    expect(count("Asha")).toBe(1);
    expect(count("Early Bird")).toBe(0); // existed before the very first run
    expect(logs).toContain("2 activities happened while the service was down; posting them now.");

    const sentCsv = fs.readFileSync(path.join(stateDir, "sent-entries.csv"), "utf-8");
    const notSentCsv = fs.readFileSync(path.join(stateDir, "skipped-entries.csv"), "utf-8");
    expect(sentCsv).toContain("Ben Das");
    expect(sentCsv).toContain("Cara Sen");
    expect(notSentCsv).toContain("Early Bird");
  }, 40_000);

  it("repeated crashes during active polling: nothing lost; a repeat only if killed mid-send", async () => {
    startWatcher();
    await waitFor(() => logs.includes("watcher initialized"), "first poll done");
    await sleep(300);

    const names: string[] = [];
    for (let i = 0; i < 8; i++) {
      const name = `Person${i} Test`;
      names.push(name);
      addRows(row(name, "Eureka", `11:${String(10 + i)}`));
      await sleep(100 + Math.floor(Math.random() * 500));
      await crash();
      startWatcher();
      await sleep(100 + Math.floor(Math.random() * 300));
    }

    await waitFor(
      () => names.every((n) => rec(n.split(" ")[0]!)?.status !== "pending"),
      "all settled",
      30_000,
    );
    await sleep(800);

    // Activities added while the process was down are treated as
    // startup baseline (not announced) — same as before. Everything
    // that WAS detected (pending) must be delivered, never lost.
    //
    // Exactly once, EXCEPT when the process was killed in the middle of
    // sending that very message: Google Chat may already have it, so it
    // is resent after restart (at-least-once, by design) and the log
    // says "interrupted by a restart" for that message.
    for (const n of names) {
      const r = rec(n.split(" ")[0]!)!;
      expect(["sent", "skipped"]).toContain(r.status);

      if (r.status === "skipped") {
        expect(count(n)).toBe(0);
        continue;
      }

      const interrupted = logs.includes(`delivery of "🟢 ${n}`);
      expect(count(n)).toBeGreaterThanOrEqual(1);
      expect(count(n)).toBeLessThanOrEqual(interrupted ? 2 : 1);
    }
  }, 60_000);
});
