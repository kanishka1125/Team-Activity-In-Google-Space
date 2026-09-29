import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TeamActivityEvent } from "../src/services/teamActivity.service.js";
import {
  TeamActivityStateStore,
  type DailyTeamActivityState,
} from "../src/services/teamActivityState.store.js";

// Modules imported below read these at load time. Tests never call
// them (everything external is replaced by fakes), so dummies are fine.
for (const name of [
  "TIME_TRACKER_API_URL",
]) {
  process.env[name] ||= "http://127.0.0.1:9/unused";
}
const {
  TeamActivityWatcherService,
  readTeamActivityWatcherConfig,
  DEFAULT_TEAM_ACTIVITY_POLL_INTERVAL_MS,
} = await import("../src/services/teamActivityWatcher.service.js");
const { GoodMorningWatcherService } = await import(
  "../src/services/goodMorningWatcher.service.js"
);

// 2026-09-24 is a Thursday. 10:00 IST = 04:30Z.
const DAY1 = new Date("2026-09-24T04:30:00Z");

function activity(name: string, project: string, start: string): TeamActivityEvent {
  const email = `${name.toLowerCase()}@x.in`;
  return {
    id: `activity-${email}-2026-09-24-${start}-${project.toLowerCase()}`,
    type: "project_change",
    name,
    email,
    project,
    previousProject: "Old",
    startTime: start,
    dateSubmitted: "24-09-2026",
    totalHours: 0,
    message: `${name} switched to ${project} from Old at ${start}`,
  };
}

// A store whose writes can be made to fail, like a full/read-only disk.
class FlakyStore extends TeamActivityStateStore {
  failWrites = false;
  override save(state: DailyTeamActivityState): void {
    if (this.failWrites) {
      const error = new Error("ENOSPC: no space left on device, write") as NodeJS.ErrnoException;
      error.code = "ENOSPC";
      throw error;
    }
    super.save(state);
  }
}

let dir: string;
let clock: Date;
let rows: TeamActivityEvent[];
let sent: string[];
let chatFails: string | null;
let ttFails: boolean;
let errors: string[];
let warns: string[];
let logs: string[];

function makeWatcher(store = new FlakyStore(dir)) {
  return new TeamActivityWatcherService({
    store,
    activitySource: {
      getActivity: async () => {
        if (ttFails) throw new TypeError("fetch failed");
        return [...rows];
      },
    },
    chat: {
      sendTeamActivityMessage: async (m: string) => {
        if (chatFails) throw new Error(chatFails);
        sent.push(m);
      },
    },
    now: () => clock,
    sleep: async () => {},
    legacyLeaveStateFile: path.join(dir, "none.json"),
  });
}

// One day from the single activity-state.json file.
function fileState(date = "2026-09-24"): DailyTeamActivityState {
  const file = path.join(dir, "activity-state.json");
  const days = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, "utf-8")) as { days: Record<string, DailyTeamActivityState["records"]> }).days
    : {};
  return { version: 1, date, records: days[date] ?? [] };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-rel-"));
  clock = DAY1;
  rows = [];
  sent = [];
  chatFails = null;
  ttFails = false;
  errors = [];
  warns = [];
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a.map(String).join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a) => void warns.push(a.map(String).join(" ")));
  vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.map(String).join(" ")));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));

// ---------------------------------------------------------------
describe("1/2. watcher configuration", () => {
  it("defaults: enabled, 15 s polling", () => {
    expect(readTeamActivityWatcherConfig({})).toEqual({
      enabled: true,
      intervalMs: 15_000,
      warnings: [],
    });
    expect(DEFAULT_TEAM_ACTIVITY_POLL_INTERVAL_MS).toBe(15_000);
  });

  it("can be disabled per instance", () => {
    for (const v of ["false", "FALSE", "0", "no", "off", " false "]) {
      expect(readTeamActivityWatcherConfig({ TEAM_ACTIVITY_WATCHER_ENABLED: v }).enabled).toBe(false);
    }
    for (const v of ["true", "1", "yes", "on"]) {
      expect(readTeamActivityWatcherConfig({ TEAM_ACTIVITY_WATCHER_ENABLED: v }).enabled).toBe(true);
    }
  });

  it("invalid values fall back to defaults with a warning", () => {
    const c = readTeamActivityWatcherConfig({
      TEAM_ACTIVITY_WATCHER_ENABLED: "maybe",
      TEAM_ACTIVITY_POLL_INTERVAL_MS: "abc",
    });
    expect(c.enabled).toBe(true);
    expect(c.intervalMs).toBe(15_000);
    expect(c.warnings).toHaveLength(2);
  });

  it("interval is configurable, with a 5 s minimum", () => {
    expect(readTeamActivityWatcherConfig({ TEAM_ACTIVITY_POLL_INTERVAL_MS: "30000" }).intervalMs).toBe(30_000);
    const low = readTeamActivityWatcherConfig({ TEAM_ACTIVITY_POLL_INTERVAL_MS: "1000" });
    expect(low.intervalMs).toBe(5_000);
    expect(low.warnings[0]).toContain("too low");
  });
});

// ---------------------------------------------------------------
describe("7. state write failures", () => {
  it("cannot persist PENDING → nothing is sent, clear error, then delivered once the disk recovers", async () => {
    const store = new FlakyStore(dir);
    const w = makeWatcher(store);
    await w.check();

    store.failWrites = true;
    rows.push(activity("Asha", "Eureka", "10:54"));
    for (let i = 0; i < 5; i++) await w.check();

    expect(sent).toEqual([]);
    expect(errors.filter((e) => e.includes("could NOT save delivery state"))).toHaveLength(1);
    expect(errors[0]).toContain("ENOSPC");
    expect(fileState().records).toHaveLength(0); // never falsely persisted

    store.failWrites = false;
    await w.check();
    expect(sent).toHaveLength(1);
    expect(fileState().records[0]!.status).toBe("sent");
    expect(logs.some((l) => l.includes("saved again"))).toBe(true);
  });

  it("delivered but SENT cannot be saved → not resent while running, clear error, saved later", async () => {
    const store = new FlakyStore(dir);
    const w = makeWatcher(store);
    await w.check();
    rows.push(activity("Asha", "Eureka", "10:54"));

    // Let the pre-send save succeed, fail the post-send save.
    let saves = 0;
    const orig = store.save.bind(store);
    store.save = (s) => {
      saves++;
      if (saves === 3) {
        const e = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        e.code = "EACCES";
        throw e;
      }
      orig(s);
    };

    await w.check();
    expect(sent).toHaveLength(1);
    expect(errors.some((e) => e.includes("SENT status could NOT be saved"))).toBe(true);

    for (let i = 0; i < 5; i++) await w.check();
    expect(sent).toHaveLength(1); // not resent
    expect(fileState().records[0]!.status).toBe("sent"); // saved on a later poll
  });

  it("state directory unusable (path is a file) → clear error, no false SENT", async () => {
    const blocked = path.join(dir, "blocked");
    fs.writeFileSync(blocked, "not a directory");
    const w = makeWatcher(new FlakyStore(blocked));
    rows.push(activity("Asha", "Eureka", "10:54"));
    await w.check();
    rows.push(activity("Ben", "KFH New", "10:55"));
    await w.check();
    await w.check();
    expect(sent).toEqual([]);
    expect(errors.filter((e) => e.includes("could NOT save delivery state"))).toHaveLength(1);
  });

  it("unreadable (not corrupt) state file is NOT quarantined", async () => {
    const store = new FlakyStore(dir);
    store.save({ version: 1, date: "2026-09-24", records: [] });
    const spy = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      const e = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      e.code = "EACCES";
      throw e;
    });
    await makeWatcher(store).check();
    spy.mockRestore();
    expect(fs.readdirSync(dir).some((f) => f.includes("corrupt"))).toBe(false);
    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------
describe("7/8. Time Tracker failure + log flooding", () => {
  it("Time Tracker down for 20 polls → no crash, one error (not 20), recovery logged, then normal", async () => {
    const w = makeWatcher();
    await w.check();
    ttFails = true;
    for (let i = 0; i < 20; i++) {
      await w.check();
      advance(15_000); // 5 minutes total
    }
    const ttErrors = errors.filter((e) => e.includes("could not read Time Tracker"));
    expect(ttErrors.length).toBeGreaterThanOrEqual(1);
    expect(ttErrors.length).toBeLessThanOrEqual(2); // first + at most one 5-min summary

    ttFails = false;
    rows.push(activity("Asha", "Eureka", "10:54"));
    await w.check();
    expect(logs.some((l) => l.includes("Time Tracker is reachable again"))).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("Google Chat failing for many polls → limited error logs, activity still pending", async () => {
    const w = makeWatcher();
    await w.check();
    rows.push(activity("Asha", "Eureka", "10:54"), activity("Ben", "KFH New", "10:55"));
    chatFails = "Google Chat webhook failed: 500 backend error";
    for (let i = 0; i < 40; i++) {
      await w.check();
      advance(15_000); // 10 minutes
    }
    const chatErrors = errors.filter((e) => e.includes("Google Chat send failed"));
    expect(chatErrors.length).toBeLessThanOrEqual(3);
    expect(fileState().records.every((r) => r.status === "pending")).toBe(true);

    chatFails = null;
    advance(5 * 60_000);
    await w.check();
    expect(sent).toHaveLength(2);
  });
});

// ---------------------------------------------------------------
describe("6. Good Morning retry window", () => {
  // 09:30 IST = 04:00Z
  const at = (hhmm: string, date = "2026-09-24") => {
    const [h, m] = hhmm.split(":").map(Number);
    return new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h! - 5, m! - 30));
  };

  function gm(stateFile: string, send: (m: string) => Promise<void>) {
    return new GoodMorningWatcherService({
      now: () => clock,
      stateFile,
      sendMessage: send,
      getQuote: async () => ({ quote: "Consistency builds results." }),
    });
  }

  it("first attempt fails (429) → retried → sent once; no second message that day, even after restart", async () => {
    const file = path.join(dir, "gm.json");
    const messages: string[] = [];
    let fail = true;
    const send = async (m: string) => {
      if (fail) throw new Error("Google Chat webhook failed: 429 RESOURCE_EXHAUSTED");
      messages.push(m);
    };

    clock = at("09:30");
    const w = gm(file, send);
    await w.check();
    expect(messages).toEqual([]);

    clock = new Date(clock.getTime() + 30_000);
    fail = false;
    await w.check(); // too soon (60s retry delay)
    expect(messages).toEqual([]);

    clock = new Date(clock.getTime() + 30_000);
    await w.check();
    expect(messages).toEqual(["Good Morning Team☀️\n\nConsistency builds results."]);

    for (let i = 0; i < 10; i++) {
      clock = new Date(clock.getTime() + 30_000);
      await w.check();
    }
    await gm(file, send).check(); // restart
    expect(messages).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).lastSentDate).toBe("2026-09-24");
  });

  it("backend was down at 9:30, starts at 9:45 → still sent", async () => {
    const messages: string[] = [];
    clock = at("09:45");
    await gm(path.join(dir, "gm.json"), async (m) => void messages.push(m)).check();
    expect(messages).toHaveLength(1);
  });

  it("not before 9:30, not after 10:00, not on weekends", async () => {
    const messages: string[] = [];
    const send = async (m: string) => void messages.push(m);
    const file = path.join(dir, "gm.json");
    clock = at("09:29");
    await gm(file, send).check();
    clock = at("10:00");
    await gm(file, send).check();
    clock = at("09:30", "2026-09-26"); // Saturday
    await gm(file, send).check();
    expect(messages).toEqual([]);
  });

  it("all attempts in the window fail → one clear 'NOT sent' error, limited retry logs", async () => {
    const w = gm(path.join(dir, "gm.json"), async () => {
      throw new Error("Google Chat webhook failed: 429");
    });
    clock = at("09:30");
    for (let i = 0; i < 70; i++) {
      await w.check();
      clock = new Date(clock.getTime() + 30_000);
    }
    expect(errors.filter((e) => e.includes("NOT sent")).length).toBe(1);
    expect(errors.filter((e) => e.includes("could not be sent")).length).toBeLessThanOrEqual(7);
  });
});
