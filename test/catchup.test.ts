import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TeamActivityEvent } from "../src/services/teamActivity.service.js";
import { TeamActivityStateStore } from "../src/services/teamActivityState.store.js";

process.env.TIME_TRACKER_API_URL ||= "http://127.0.0.1:9/unused";
const { TeamActivityWatcherService } = await import(
  "../src/services/teamActivityWatcher.service.js"
);

// 2026-09-29 14:00 IST
const DAY = new Date("2026-09-29T08:30:00Z");
const NEXT_DAY = new Date("2026-09-30T08:30:00Z");

function act(name: string, project: string, start: string, date = "29-09-2026", type: TeamActivityEvent["type"] = "login", from: string | null = null): TeamActivityEvent {
  const email = `${name.toLowerCase().split(" ")[0]}@x.in`;
  const iso = date.split("-").reverse().join("-");
  return {
    id: type === "leave" ? `leave-${email}-${iso}` : `activity-${email}-${iso}-${start}-${project.toLowerCase()}`,
    type, name, email, project, previousProject: from, startTime: start, dateSubmitted: date, totalHours: 0,
    message: type === "leave" ? `${name} is on leave today` : from ? `${name} switched to ${project} from ${from}, at ${start}` : `${name} has started working on ${project} at ${start}`,
  };
}

let dir: string;
let rows: TeamActivityEvent[];
let sent: string[];
let clock: Date;
let logs: string[];
let warns: string[];

const watcher = () =>
  new TeamActivityWatcherService({
    store: new TeamActivityStateStore(dir),
    activitySource: { getActivity: async () => [...rows] },
    chat: { sendTeamActivityMessage: async (m: string) => void sent.push(m) },
    now: () => clock,
    sleep: async () => {},
    legacyLeaveStateFile: path.join(dir, "none.json"),
  });

const readCsv = (name: string) => fs.readFileSync(path.join(dir, name), "utf-8");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "catchup-"));
  rows = [];
  sent = [];
  clock = DAY;
  logs = [];
  warns = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a) => void warns.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("posting activity missed while the service was down", () => {
  it("brand-new install mid-day: existing activity is recorded but NOT posted (no flood)", async () => {
    rows = [act("Asha Rao", "Eureka", "9:30"), act("Ben Das", "Li3ib", "10:05")];
    await watcher().check();
    expect(sent).toEqual([]);
    expect(logs.join("\n")).toContain("first run");
  });

  it("restart later the same day: everything entered while down is posted, oldest first", async () => {
    rows = [act("Asha Rao", "Eureka", "9:30")];
    let w = watcher();
    await w.check(); // first ever run → recorded, not posted
    rows.push(act("Ben Das", "Li3ib", "10:05"));
    await w.check(); // normal → posted
    expect(sent).toHaveLength(1);

    // server goes down; three entries happen meanwhile
    rows.push(
      act("Cara Sen", "RVVPL", "10:40"),
      act("Dev Kumar", "KFH New", "11:15"),
      act("Ben Das", "Suffix", "12:30", "29-09-2026", "project_change", "Li3ib"),
    );
    clock = new Date(DAY.getTime() + 3 * 3600_000); // back 3 h later
    w = watcher();
    await w.check();

    expect(sent.slice(1)).toEqual([
      "🟢 Cara Sen has started working on RVVPL at 10:40",
      "🟢 Dev Kumar has started working on KFH New at 11:15",
      "🟢 Ben Das switched to Suffix from Li3ib, at 12:30",
    ]);
    expect(logs.join("\n")).toContain("3 activities happened while the service was down; posting them now.");
    expect(sent.filter((m) => m.includes("Asha"))).toHaveLength(0); // first-run record stays unposted

    // and never again
    await watcher().check();
    expect(sent).toHaveLength(4);
  });

  it("down across midnight (yesterday's file exists, none for today): all of today is posted", async () => {
    clock = new Date("2026-09-28T08:30:00Z");
    rows = [act("Old Day", "Eureka", "9:30", "28-09-2026")];
    await watcher().check();

    clock = NEXT_DAY; // service was off all morning
    rows = [act("Asha Rao", "Eureka", "9:30", "30-09-2026"), act("Ben Das", "Li3ib", "10:05", "30-09-2026")];
    await watcher().check();
    expect(sent).toEqual([
      "🟢 Asha Rao has started working on Eureka at 9:30",
      "🟢 Ben Das has started working on Li3ib at 10:05",
    ]);
  });

  it("unreadable state file: nothing is replayed (can't tell what was sent)", async () => {
    rows = [act("Asha Rao", "Eureka", "9:30")];
    await watcher().check();
    fs.writeFileSync(path.join(dir, "activity-state.json"), "{broken");
    rows.push(act("Ben Das", "Li3ib", "10:05"));
    await watcher().check();
    expect(sent).toEqual([]);
  });

  it("leave is still announced once on start-up", async () => {
    rows = [act("Lina Roy", "", "", "29-09-2026", "leave")];
    await watcher().check();
    await watcher().check();
    expect(sent).toEqual(["🔴 Lina Roy is on leave today"]);
  });
});

describe("readable CSV 'sheets' (same files every day)", () => {
  it("sent-entries.csv and skipped-entries.csv: date column, sorted, reasons, Excel-friendly", async () => {
    rows = [act("Old Timer", "Eureka", "9:05")];
    await watcher().check(); // first run → Old Timer 'Not posted'

    let fail = true;
    const w2 = new TeamActivityWatcherService({
      store: new TeamActivityStateStore(dir),
      activitySource: { getActivity: async () => [...rows] },
      chat: {
        sendTeamActivityMessage: async (m: string) => {
          if (fail && m.includes("Cara")) throw new Error("Google Chat webhook failed: 429 RESOURCE_EXHAUSTED");
          sent.push(m);
        },
      },
      now: () => clock,
      sleep: async () => {},
      legacyLeaveStateFile: path.join(dir, "none.json"),
    });
    rows.push(act("Ben Das", "Li3ib", "10:05"), act("Cara Sen", "RVVPL", "11:40"), act("Ben Das", "Suffix", "12:30", "29-09-2026", "project_change", "Li3ib"));
    await w2.check();

    const sentCsv = readCsv("sent-entries.csv");
    const skipped = readCsv("skipped-entries.csv");

    expect(sentCsv.charCodeAt(0)).toBe(0xfeff);
    expect(sentCsv).toContain("Date,Time,Employee,Activity,From project,To project,Message,Sent at (IST)");
    expect(sentCsv).toContain("29-09-2026,10:05 AM,Ben Das,Started working,,Li3ib");

    expect(skipped).toContain("Date,Time,Employee,Activity,From project,To project,Message,Status,Reason,Attempts,Next try (IST)");
    expect(skipped).toContain("Old Timer");
    expect(skipped).toContain("Not posted,Already existed when the service first started");
    expect(skipped).toContain("Waiting to be sent,Last attempt failed: Google Chat webhook failed: 429");
    // after a 429 sending pauses, so the later switch is still queued
    expect(skipped).toContain('"🟢 Ben Das switched to Suffix from Li3ib, at 12:30",Waiting to be sent,Queued');

    // error clears → Cara moves from skipped-entries to sent-entries
    fail = false;
    clock = new Date(clock.getTime() + 10 * 60_000);
    await w2.check();
    const after = readCsv("sent-entries.csv");
    expect(after).toContain("Cara Sen");
    expect(after).toContain('"🟢 Ben Das switched to Suffix from Li3ib, at 12:30"'); // comma escaped
    expect(after.indexOf("10:05 AM")).toBeLessThan(after.indexOf("11:40 AM"));
    expect(after.indexOf("11:40 AM")).toBeLessThan(after.indexOf("12:30 PM"));
    expect(readCsv("skipped-entries.csv")).not.toContain("Cara Sen");
  });

  it("CSV locked (e.g. open in Excel) → one warning, state saved, sending continues", async () => {
    await watcher().check();
    fs.rmSync(path.join(dir, "sent-entries.csv"));
    fs.mkdirSync(path.join(dir, "sent-entries.csv")); // makes writing it fail
    const w = watcher();
    await w.check();
    rows.push(act("Asha Rao", "Eureka", "9:30"), act("Ben Das", "Li3ib", "10:05"));
    await w.check();
    expect(sent).toHaveLength(2);
    expect(warns.filter((m) => m.includes("could not update sent-entries.csv"))).toHaveLength(1);
    const json = JSON.parse(fs.readFileSync(path.join(dir, "activity-state.json"), "utf-8"));
    expect(json.days["2026-09-29"].every((r: { status: string }) => r.status === "sent")).toBe(true);
  });

  it("same three files every day; after midnight they start fresh (yesterday removed)", async () => {
    rows = [act("Asha Rao", "Eureka", "9:30")];
    const w = watcher();
    await w.check(); // first run
    rows.push(act("Ben Das", "Li3ib", "10:05"));
    await w.check();
    expect(readCsv("sent-entries.csv")).toContain("Ben Das");

    clock = NEXT_DAY; // after midnight
    rows = [];
    await w.check();

    expect(fs.readdirSync(dir).sort()).toEqual(["activity-state.json", "sent-entries.csv", "skipped-entries.csv"]);
    expect(readCsv("sent-entries.csv")).not.toContain("Ben Das");
    expect(readCsv("skipped-entries.csv")).not.toContain("Asha Rao");
    const json = JSON.parse(fs.readFileSync(path.join(dir, "activity-state.json"), "utf-8"));
    expect(Object.keys(json.days)).toEqual(["2026-09-30"]);

    rows = [act("Cara Sen", "RVVPL", "9:40", "30-09-2026")];
    await w.check();
    expect(readCsv("sent-entries.csv")).toContain("30-09-2026,9:40 AM,Cara Sen");
    expect(fs.readdirSync(dir)).toHaveLength(3);
  });

  it("a day with a message still waiting is kept (in the same files) until it is sent", async () => {
    let fail = true;
    const w = new TeamActivityWatcherService({
      store: new TeamActivityStateStore(dir),
      activitySource: { getActivity: async () => [...rows] },
      chat: { sendTeamActivityMessage: async (m: string) => { if (fail) throw new Error("Google Chat webhook failed: 503"); sent.push(m); } },
      now: () => clock, sleep: async () => {}, legacyLeaveStateFile: path.join(dir, "none.json"),
    });
    await w.check();
    rows = [act("Late Worker", "Eureka", "23:58")];
    await w.check();
    clock = NEXT_DAY;
    rows = [];
    await w.check();
    expect(readCsv("skipped-entries.csv")).toContain("29-09-2026,11:58 PM,Late Worker");
    fail = false;
    clock = new Date(NEXT_DAY.getTime() + 10 * 60_000);
    await w.check();
    expect(sent).toEqual(["🟢 Late Worker has started working on Eureka at 23:58"]);
    const json = JSON.parse(fs.readFileSync(path.join(dir, "activity-state.json"), "utf-8"));
    expect(Object.keys(json.days)).toEqual(["2026-09-30"]);
  });

  it("CSVs are (re)created on start-up even when nothing new happens", async () => {
    rows = [act("Asha Rao", "Eureka", "9:30")];
    await watcher().check();
    for (const f of ["sent-entries.csv", "skipped-entries.csv"]) fs.rmSync(path.join(dir, f));
    await watcher().check(); // restart, no new activity
    expect(fs.existsSync(path.join(dir, "sent-entries.csv"))).toBe(true);
    expect(readCsv("skipped-entries.csv")).toContain("Asha Rao");
  });

  it("upgrade: old dated files are merged into activity-state.json and removed; nothing re-sent", async () => {
    const rec = (id: string, status: string) => ({
      activityId: id, type: "login", employee: id, email: `${id}@x.in`, fromProject: null, toProject: "Eureka",
      timestamp: "9:30 AM", message: `🟢 ${id} has started working`, status, attempts: 0, lastError: null,
      nextAttemptAt: null, sendStartedAt: null, detectedAt: "2026-09-29T04:00:00Z", sentAt: status === "sent" ? "2026-09-29T04:00:01Z" : null,
    });
    fs.writeFileSync(path.join(dir, "2026-09-29.json"), JSON.stringify({ version: 1, date: "2026-09-29", records: [rec("OldSent", "sent"), rec("OldPending", "pending")] }));
    fs.writeFileSync(path.join(dir, "2026-09-29-sent.csv"), "old");
    fs.writeFileSync(path.join(dir, "2026-09-29-not-sent.csv"), "old");

    await watcher().check();

    expect(fs.readdirSync(dir).sort()).toEqual(["activity-state.json", "sent-entries.csv", "skipped-entries.csv"]);
    expect(sent).toEqual(["🟢 OldPending has started working"]); // pending delivered, sent not repeated
    expect(readCsv("sent-entries.csv")).toContain("OldSent");
    expect(readCsv("sent-entries.csv")).toContain("OldPending");
  });
});
