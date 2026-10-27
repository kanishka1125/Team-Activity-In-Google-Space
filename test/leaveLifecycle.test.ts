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

// A leave is just another activity: same ID/state/retry lifecycle.
// 2026-09-29 14:00 IST
const DAY = new Date("2026-09-29T08:30:00Z");
const TODAY = "2026-09-29";

function leave(name: string): TeamActivityEvent {
  const email = `${name.toLowerCase().split(" ")[0]}@x.in`;

  return {
    id: `leave-${email}-${TODAY}`,
    type: "leave",
    name,
    email,
    project: "",
    previousProject: null,
    startTime: "",
    dateSubmitted: "29-09-2026",
    totalHours: 0,
    message: `${name} is on leave today`,
  };
}

function work(name: string, project: string, start: string): TeamActivityEvent {
  const email = `${name.toLowerCase().split(" ")[0]}@x.in`;

  return {
    id: `activity-${email}-${TODAY}-${start}-${project.toLowerCase()}`,
    type: "login",
    name,
    email,
    project,
    previousProject: null,
    startTime: start,
    dateSubmitted: "29-09-2026",
    totalHours: 0,
    message: `${name} has started working on ${project} at ${start}`,
  };
}

let dir: string;
let rows: TeamActivityEvent[];
let sent: string[];
let clock: Date;
let chatDown: boolean;

const watcher = () =>
  new TeamActivityWatcherService({
    store: new TeamActivityStateStore(dir),
    activitySource: { getActivity: async () => [...rows] },
    chat: {
      sendTeamActivityMessage: async (m: string) => {
        if (chatDown) {
          throw new Error("Google Chat webhook failed: 500");
        }

        sent.push(m);
      },
    },
    now: () => clock,
    sleep: async () => {},
    legacyLeaveStateFile: path.join(dir, "none.json"),
  });

const statusOf = (id: string) =>
  new TeamActivityStateStore(dir)
    .load(TODAY)
    .state.records.find((r) => r.activityId === id)?.status;

const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "leave-"));
  rows = [];
  sent = [];
  clock = DAY;
  chatDown = false;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("leave lifecycle = normal activity lifecycle", () => {
  it("1. a new leave while the watcher is running → one notification, persisted as SENT", async () => {
    const w = watcher();
    await w.check();
    const krishna = leave("Krishna Kumar");
    rows.push(krishna);
    await w.check();

    expect(sent).toEqual(["🔴 Krishna Kumar is on leave today"]);
    expect(statusOf(krishna.id)).toBe("sent");
  });

  it("2. the next polling cycle sees the same leave → no second notification", async () => {
    const w = watcher();
    await w.check();
    rows.push(leave("Krishna Kumar"));
    await w.check();
    await w.check();
    await w.check();

    expect(sent).toHaveLength(1);
  });

  it("3. restart after the leave was SENT → nothing is sent", async () => {
    const w = watcher();
    await w.check();
    rows.push(leave("Krishna Kumar"));
    await w.check();
    expect(sent).toHaveLength(1);

    await watcher().check();
    await watcher().check();
    expect(sent).toHaveLength(1);
  });

  it("4a. no state yet on startup, leaves already in Time Tracker → NOT posted as a batch", async () => {
    rows = [leave("Krishna Kumar"), leave("Komal Dumka"), leave("Ankur")];
    await watcher().check();
    await watcher().check();

    expect(sent).toEqual([]);
    for (const r of rows) {
      expect(statusOf(r.id)).toBe("skipped");
    }
  });

  it("4b. today's state unusable on startup, leaves already in Time Tracker → NOT posted as a batch", async () => {
    rows = [work("Asha Rao", "Eureka", "9:30")];
    await watcher().check();

    fs.writeFileSync(path.join(dir, "activity-state.json"), "{broken");
    rows.push(leave("Krishna Kumar"), leave("Komal Dumka"), leave("Ankur"));
    await watcher().check();

    expect(sent).toEqual([]);
  });

  it("4c. leaves known at startup are treated exactly like existing work activity", async () => {
    rows = [work("Asha Rao", "Eureka", "9:30"), leave("Krishna Kumar")];
    await watcher().check();

    expect(sent).toEqual([]);
    expect(statusOf(work("Asha Rao", "Eureka", "9:30").id)).toBe("skipped");
    expect(statusOf(leave("Krishna Kumar").id)).toBe("skipped");
  });

  it("5. a NEW leave after startup (others already existing) → only the new one is sent", async () => {
    rows = [leave("Komal Dumka"), leave("Ankur")];
    const w = watcher();
    await w.check();
    expect(sent).toEqual([]);

    rows.push(leave("Krishna Kumar"));
    await w.check();
    expect(sent).toEqual(["🔴 Krishna Kumar is on leave today"]);

    await w.check();
    expect(sent).toHaveLength(1);

    await watcher().check();
    expect(sent).toHaveLength(1);
  });

  it("6. two employees go on leave at different times → one notification each", async () => {
    const w = watcher();
    await w.check();

    rows.push(leave("Krishna Kumar"));
    await w.check();
    expect(sent).toEqual(["🔴 Krishna Kumar is on leave today"]);

    advance(30 * 60_000);
    rows.push(leave("Komal Dumka"));
    await w.check();
    expect(sent).toEqual([
      "🔴 Krishna Kumar is on leave today",
      "🔴 Komal Dumka is on leave today",
    ]);

    await w.check();
    await watcher().check();
    expect(sent).toHaveLength(2);
  });

  it("7. Google Chat fails → the leave stays PENDING and the existing retry mechanism retries it", async () => {
    const w = watcher();
    await w.check();

    chatDown = true;
    const krishna = leave("Krishna Kumar");
    rows.push(krishna);
    await w.check();

    expect(sent).toEqual([]);
    expect(statusOf(krishna.id)).toBe("pending");

    // chat is back, but the retry backoff has not elapsed yet
    chatDown = false;
    await w.check();
    expect(sent).toEqual([]);

    advance(60_000);
    await w.check();
    expect(sent).toEqual(["🔴 Krishna Kumar is on leave today"]);
  });

  it("7b. a PENDING leave survives a restart and is retried by the new process", async () => {
    const w = watcher();
    await w.check();

    chatDown = true;
    const krishna = leave("Krishna Kumar");
    rows.push(krishna);
    await w.check();
    expect(statusOf(krishna.id)).toBe("pending");

    chatDown = false;
    advance(60_000);
    await watcher().check();
    expect(sent).toEqual(["🔴 Krishna Kumar is on leave today"]);
  });

  it("8. a successful retry → SENT, and never sent again", async () => {
    const w = watcher();
    await w.check();

    chatDown = true;
    const krishna = leave("Krishna Kumar");
    rows.push(krishna);
    await w.check();

    chatDown = false;
    advance(60_000);
    await w.check();
    expect(sent).toHaveLength(1);
    expect(statusOf(krishna.id)).toBe("sent");

    advance(60_000);
    await w.check();
    await watcher().check();
    expect(sent).toHaveLength(1);
  });

  it("a leave that disappears and reappears in Time Tracker is not announced twice (stable ID)", async () => {
    const w = watcher();
    await w.check();
    rows.push(leave("Krishna Kumar"));
    await w.check();

    rows = [];
    await w.check();
    rows = [leave("Krishna Kumar")];
    await w.check();

    expect(sent).toHaveLength(1);
  });
});
