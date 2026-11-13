// End to end: the real Team Activity service + the real watcher + the real
// state files. A leave that is in Keka, in the Time Tracker, or in both is
// sent exactly once, also across polls, a restart and a pending → approved
// change. Only Google Chat, Keka and the Time Tracker are fakes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RawTimeTrackerEntry } from "../src/integrations/timeTracker/timeTracker.types.js";
import { TeamActivityStateStore } from "../src/services/teamActivityState.store.js";

let trackerRows: RawTimeTrackerEntry[] = [];

vi.mock("../src/integrations/timeTracker/timeTracker.service.js", () => ({
  TimeTrackerService: class {
    async getTimeEntries() {
      return trackerRows;
    }
  },
}));

const { TeamActivityService } = await import("../src/services/teamActivity.service.js");
const { TeamActivityWatcherService } = await import("../src/services/teamActivityWatcher.service.js");

const DATE = "13-11-2026"; // Friday
const NOW = new Date("2026-11-13T05:00:00Z"); // 10:30 IST

const work = (name: string, email: string): RawTimeTrackerEntry => ({
  rowIndex: 1, name, email, project: "Eureka", note: "", startTime: "09:30", endTime: "",
  dateSubmitted: DATE, totalHours: 0, isOnLeave: false, isAuto: false, actionBy: "",
});
const leaveRow = (name: string, email: string): RawTimeTrackerEntry => ({
  ...work(name, email), project: "On Leave", startTime: "", isOnLeave: true,
});

let dir: string;
let sent: string[];
let kekaPeople: { name: string; email: string; part?: "full" | "first" | "second" }[];

const watcher = () =>
  new TeamActivityWatcherService({
    store: new TeamActivityStateStore(dir),
    activitySource: new TeamActivityService({ getLeavePeople: async () => kekaPeople }),
    chat: { sendTeamActivityMessage: async (m: string) => void sent.push(m) },
    now: () => NOW,
    sleep: async () => {},
    legacyLeaveStateFile: path.join(dir, "none.json"),
  });

const leaveMessages = () => sent.filter((m) => m.includes("leave today")).sort();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "leave-dupes-"));
  sent = [];
  kekaPeople = [];
  trackerRows = [];
  for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("leave from Keka and from the Time Tracker is sent exactly once", () => {
  it("Keka only, Tracker only and both: one message each, across many polls", async () => {
    const w = watcher();
    await w.check(); // first run: baseline (nothing yet)

    trackerRows = [work("Mia", "mia@x.com"), leaveRow("Devid Kumar", "devid@x.com"), leaveRow("Both Person", "both@x.com")];
    kekaPeople = [
      { name: "Aniket Kaushik", email: "aniket@x.com" }, // Keka only (pending, not synced)
      { name: "Both Person", email: "both@x.com" }, // in both
    ];

    for (let i = 0; i < 5; i++) await w.check();

    for (const name of ["Aniket Kaushik", "Both Person", "Devid Kumar"]) {
      expect(sent.filter((m) => m.includes(`${name} is on leave today`))).toHaveLength(1);
    }
    expect(leaveMessages()).toHaveLength(3);
  });

  it("a restart does not send them again", async () => {
    const w1 = watcher();
    await w1.check();

    trackerRows = [work("Mia", "mia@x.com"), leaveRow("Devid Kumar", "devid@x.com")];
    kekaPeople = [{ name: "Aniket Kaushik", email: "aniket@x.com" }, { name: "Devid Kumar", email: "devid@x.com" }];
    await w1.check();
    await w1.check();
    expect(leaveMessages()).toHaveLength(2);

    const w2 = watcher(); // service restarted
    await w2.check();
    await w2.check();

    expect(leaveMessages()).toHaveLength(2);
  });

  it("pending → approved, and the Time Tracker syncing the same leave later, do not repeat it", async () => {
    const w = watcher();
    await w.check();

    trackerRows = [work("Mia", "mia@x.com")];
    kekaPeople = [{ name: "Aniket Kaushik", email: "aniket@x.com" }];
    await w.check();
    expect(leaveMessages()).toHaveLength(1);

    // Approved in Keka (still the same person on leave) and the sync adds a tracker row.
    trackerRows = [work("Mia", "mia@x.com"), leaveRow("Aniket Kaushik", "aniket@x.com")];
    await w.check();
    await w.check();

    expect(leaveMessages()).toHaveLength(1);
  });

  it("the next day the same ongoing leave is announced again (once)", async () => {
    const w = watcher();
    await w.check();
    trackerRows = [work("Mia", "mia@x.com")];
    kekaPeople = [{ name: "Aniket Kaushik", email: "aniket@x.com" }];
    await w.check();
    expect(leaveMessages()).toHaveLength(1);

    // Monday 16 Nov, 10:30 IST
    const monday = new Date("2026-11-16T05:00:00Z");
    vi.setSystemTime(monday);
    const w2 = new TeamActivityWatcherService({
      store: new TeamActivityStateStore(dir),
      activitySource: new TeamActivityService({ getLeavePeople: async () => kekaPeople }),
      chat: { sendTeamActivityMessage: async (m: string) => void sent.push(m) },
      now: () => monday,
      sleep: async () => {},
      legacyLeaveStateFile: path.join(dir, "none.json"),
    });
    trackerRows = [{ ...work("Mia", "mia@x.com"), dateSubmitted: "16-11-2026" }];
    await w2.check();
    await w2.check();
    await w2.check();

    expect(leaveMessages()).toHaveLength(2);
  });
});

describe("a leave already sent is never sent again from the other source", () => {
  it("half-day sent from Keka, then the Time Tracker shows the same leave (even with another email): not sent again", async () => {
    const w = watcher();
    await w.check();

    trackerRows = [work("Mia", "mia@x.com")];
    kekaPeople = [{ name: "Aniket Kaushik", email: "aniket@x.com", part: "first" }];
    await w.check();
    expect(leaveMessages()).toHaveLength(1);
    expect(leaveMessages()[0]).toBe("🌗 Aniket Kaushik is on half-day leave today (first half)");

    trackerRows = [work("Mia", "mia@x.com"), leaveRow("Aniket Kaushik", "aniket@x.com")];
    await w.check();
    trackerRows = [work("Mia", "mia@x.com"), leaveRow("Aniket Kaushik", "aniket.k@other.com")]; // other email
    await w.check();
    await watcher().check(); // restart

    expect(leaveMessages()).toHaveLength(1);
  });

  it("Time Tracker leave sent first, then Keka lists the same person (other email): not sent again", async () => {
    const w = watcher();
    await w.check();

    trackerRows = [work("Mia", "mia@x.com"), leaveRow("Devid Kumar", "devid@x.com")];
    await w.check();
    expect(leaveMessages()).toHaveLength(1);

    kekaPeople = [{ name: "Devid Kumar", email: "devid.k@other.com", part: "full" }];
    await w.check();
    await watcher().check();

    expect(leaveMessages()).toHaveLength(1);
  });

  it("a half-day that later becomes a whole day is not announced a second time", async () => {
    const w = watcher();
    await w.check();

    trackerRows = [work("Mia", "mia@x.com")];
    kekaPeople = [{ name: "Aniket Kaushik", email: "aniket@x.com", part: "first" }];
    await w.check();
    kekaPeople = [{ name: "Aniket Kaushik", email: "aniket@x.com", part: "full" }];
    await w.check();

    expect(leaveMessages()).toHaveLength(1);
  });
});
