import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TeamActivityEvent } from "../src/services/teamActivity.service.js";
import { TeamActivityStateStore } from "../src/services/teamActivityState.store.js";

// The module creates a default watcher on import, which needs this
// variable. Tests inject their own fakes, so any value works.
process.env.TIME_TRACKER_API_URL ||= "http://127.0.0.1:9/unused";
const { TeamActivityWatcherService } = await import(
  "../src/services/teamActivityWatcher.service.js"
);

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

// 2026-09-24 10:00 IST
const DAY1 = new Date("2026-09-24T04:30:00Z");
const DAY2 = new Date("2026-09-25T04:30:00Z");

function activity(
  name: string,
  project: string,
  start: string,
  date = "24-09-2026",
  type: TeamActivityEvent["type"] = "project_change",
): TeamActivityEvent {
  const email = `${name.toLowerCase()}@x.in`;
  const iso = date.split("-").reverse().join("-");

  return {
    id:
      type === "leave"
        ? `leave-${email}-${iso}`
        : `activity-${email}-${iso}-${start}-${project.toLowerCase()}`,
    type,
    name,
    email,
    project,
    previousProject: type === "project_change" ? "Old" : null,
    startTime: start,
    dateSubmitted: date,
    totalHours: 0,
    message:
      type === "leave"
        ? `${name} is on leave today`
        : `${name} switched to ${project} from Old at ${start}`,
  };
}

class FakeChat {
  sent: string[] = [];
  // Queue of outcomes: "ok" | "429" | "500" | "network"
  outcomes: string[] = [];
  fallback = "ok";

  async sendTeamActivityMessage(message: string) {
    const outcome = this.outcomes.shift() ?? this.fallback;

    if (outcome === "429") {
      throw new Error(
        'Google Chat webhook failed: 429 {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}',
      );
    }

    if (outcome === "500") {
      throw new Error("Google Chat webhook failed: 500 backend error");
    }

    if (outcome === "network") {
      throw new TypeError("fetch failed");
    }

    this.sent.push(message);
  }
}

class Harness {
  dir: string;
  chat = new FakeChat();
  rows: TeamActivityEvent[] = [];
  clock = DAY1;
  legacyFile: string;

  constructor(dir: string) {
    this.dir = dir;
    this.legacyFile = path.join(dir, "legacy-leave.json");
  }

  // A new watcher = a new process after a restart.
  watcher() {
    return new TeamActivityWatcherService({
      store: new TeamActivityStateStore(this.dir),
      activitySource: { getActivity: async () => [...this.rows] },
      chat: this.chat,
      now: () => this.clock,
      sleep: async () => {},
      legacyLeaveStateFile: this.legacyFile,
    });
  }

  advance(ms: number) {
    this.clock = new Date(this.clock.getTime() + ms);
  }

  // Reads one day from the single activity-state.json file.
  state(date = "2026-09-24") {
    const data = JSON.parse(
      fs.readFileSync(path.join(this.dir, "activity-state.json"), "utf-8"),
    ) as { days: Record<string, Array<Record<string, unknown>>> };
    if (!data.days[date]) throw new Error(`no entries for ${date}`);
    return { date, records: data.days[date]! };
  }

  hasDay(date: string) {
    const file = path.join(this.dir, "activity-state.json");
    if (!fs.existsSync(file)) return false;
    return date in (JSON.parse(fs.readFileSync(file, "utf-8")) as { days: object }).days;
  }

  statusOf(id: string, date = "2026-09-24") {
    return this.state(date).records.find((r) => r.activityId === id)
      ?.status;
  }
}

let dir: string;
let h: Harness;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-state-"));
  h = new Harness(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe("Team Activity delivery state", () => {
  it("new activity → pending → sent, and is saved as SENT", async () => {
    const w = h.watcher();
    await w.check(); // startup baseline (nothing yet)

    const a = activity("Asha", "Eureka", "10:54");
    h.rows.push(a);
    await w.check();

    expect(h.chat.sent).toEqual([`🟢 ${a.message}`]);
    const rec = h.state().records.find((r) => r.activityId === a.id)!;
    expect(rec.status).toBe("sent");
    expect(rec.sentAt).toBeTruthy();
    expect(rec.employee).toBe("Asha");
    expect(rec.fromProject).toBe("Old");
    expect(rec.toProject).toBe("Eureka");
    expect(rec.timestamp).toBe("10:54 AM");
  });

  it("already SENT activity is never resent (many polls)", async () => {
    const w = h.watcher();
    await w.check();
    h.rows.push(activity("Asha", "Eureka", "10:54"));

    for (let i = 0; i < 10; i++) await w.check();

    expect(h.chat.sent).toHaveLength(1);
  });

  it("empty / no-new-activity responses send nothing and don't break", async () => {
    const w = h.watcher();
    await w.check();
    await w.check();
    expect(h.chat.sent).toEqual([]);

    h.rows.push(activity("Asha", "Eureka", "10:54"));
    await w.check();
    h.rows = [];
    await w.check();
    expect(h.chat.sent).toHaveLength(1);
  });

  it("duplicate activity in the same response → one notification", async () => {
    const w = h.watcher();
    await w.check();
    const a = activity("Shivam", "Eureka", "10:54");
    h.rows.push(a, { ...a }, { ...a });
    await w.check();
    await w.check();

    expect(h.chat.sent).toHaveLength(1);
    expect(
      h.state().records.filter((r) => r.activityId === a.id),
    ).toHaveLength(1);
  });

  it("overlapping checks do not double-send", async () => {
    const w = h.watcher();
    await w.check();
    h.rows.push(activity("Asha", "Eureka", "10:54"));
    await Promise.all([w.check(), w.check(), w.check()]);
    expect(h.chat.sent).toHaveLength(1);
  });

  it("429 → stays PENDING, not marked sent, retried after backoff", async () => {
    const w = h.watcher();
    await w.check();
    const a = activity("Asha", "Eureka", "10:54");
    const b = activity("Ben", "KFH New", "10:55");
    h.rows.push(a, b);
    h.chat.outcomes = ["429"];

    await w.check();
    expect(h.chat.sent).toEqual([]);
    expect(h.statusOf(a.id)).toBe("pending");
    expect(h.statusOf(b.id)).toBe("pending"); // round stopped on 429
    const rec = h.state().records.find((r) => r.activityId === a.id)!;
    expect(rec.attempts).toBe(1);
    expect(String(rec.lastError)).toContain("429");

    await w.check(); // still in cooldown
    expect(h.chat.sent).toEqual([]);

    h.advance(6_000);
    await w.check();
    expect(h.chat.sent).toEqual([`🟢 ${a.message}`, `🟢 ${b.message}`]);
    expect(h.statusOf(a.id)).toBe("sent");
    expect(h.statusOf(b.id)).toBe("sent");
  });

  it("temporary failure (500 / network) → stays PENDING, then delivered", async () => {
    const w = h.watcher();
    await w.check();
    const a = activity("Asha", "Eureka", "10:54");
    h.rows.push(a);
    h.chat.outcomes = ["500", "network"];

    await w.check();
    expect(h.statusOf(a.id)).toBe("pending");
    h.advance(6_000);
    await w.check();
    expect(h.statusOf(a.id)).toBe("pending");
    h.advance(11_000);
    await w.check();
    expect(h.statusOf(a.id)).toBe("sent");
    expect(h.chat.sent).toHaveLength(1);
  });

  it("never drops a record, even after many failures", async () => {
    const w = h.watcher();
    await w.check();
    const a = activity("Asha", "Eureka", "10:54");
    h.rows.push(a);
    h.chat.fallback = "500";

    for (let i = 0; i < 20; i++) {
      await w.check();
      h.advance(10 * 60_000);
    }

    expect(h.statusOf(a.id)).toBe("pending");
    h.chat.fallback = "ok";
    await w.check();
    expect(h.statusOf(a.id)).toBe("sent");
  });

  it("restart: SENT not resent, PENDING recovered and becomes SENT", async () => {
    let w = h.watcher();
    await w.check();
    const a = activity("Asha", "Eureka", "10:54");
    const b = activity("Ben", "KFH New", "10:55");
    const c = activity("Cara", "RVVPL", "10:56");
    h.rows.push(a, b, c);
    h.chat.outcomes = ["ok", "ok", "500"];
    await w.check();
    expect(h.statusOf(c.id)).toBe("pending");

    // "crash": throw the watcher away, start a new one
    h.advance(60_000);
    w = h.watcher();
    await w.check();

    expect(h.chat.sent).toEqual([
      `🟢 ${a.message}`,
      `🟢 ${b.message}`,
      `🟢 ${c.message}`,
    ]);
    expect(h.statusOf(c.id)).toBe("sent");
  });

  it("restart: no historical replay of existing activity", async () => {
    h.rows.push(
      activity("Asha", "Eureka", "09:30"),
      activity("Ben", "KFH New", "09:40"),
    );
    let w = h.watcher();
    await w.check();
    expect(h.chat.sent).toEqual([]);
    expect(h.statusOf(h.rows[0]!.id)).toBe("skipped");

    w = h.watcher();
    await w.check();
    await w.check();
    expect(h.chat.sent).toEqual([]);
  });

  it("restart before notification: in-flight record is resent after crash", async () => {
    const w = h.watcher();
    await w.check();
    const a = activity("Asha", "Eureka", "10:54");
    h.rows.push(a);

    // Simulate a crash in the middle of the send.
    let release!: () => void;
    const hanging = new Promise<void>((r) => (release = r));
    const origSend = h.chat.sendTeamActivityMessage.bind(h.chat);
    h.chat.sendTeamActivityMessage = () => hanging;
    void w.check();
    await new Promise((r) => setTimeout(r, 10));

    const inFlight = h.state().records.find((r) => r.activityId === a.id)!;
    expect(inFlight.status).toBe("pending");
    expect(inFlight.sendStartedAt).toBeTruthy();

    // New process
    h.chat.sendTeamActivityMessage = origSend;
    const w2 = h.watcher();
    await w2.check();
    expect(h.chat.sent).toEqual([`🟢 ${a.message}`]);
    expect(h.statusOf(a.id)).toBe("sent");
    release();
  });

  it("leave seen on a first run is recorded but not posted, and never posted after restart", async () => {
    const lv = activity("Lina", "", "", "24-09-2026", "leave");
    h.rows.push(lv);
    await h.watcher().check();
    await h.watcher().check();
    expect(h.chat.sent).toEqual([]);
    expect(h.statusOf(lv.id)).toBe("skipped");
  });

  it("leave already sent by the old implementation is not resent", async () => {
    const lv = activity("Lina", "", "", "24-09-2026", "leave");
    fs.writeFileSync(h.legacyFile, JSON.stringify([lv.id]));
    h.rows.push(lv);
    await h.watcher().check();
    expect(h.chat.sent).toEqual([]);
    expect(h.statusOf(lv.id)).toBe("sent");
  });

  it("daily state: a new file per day, previous day cleaned up when nothing is pending", async () => {
    const w = h.watcher();
    await w.check();
    h.rows.push(activity("Asha", "Eureka", "17:00"));
    await w.check();
    expect(h.hasDay("2026-09-24")).toBe(true);

    h.clock = DAY2;
    h.rows = [activity("Ben", "KFH New", "09:40", "25-09-2026")];
    await w.check();

    expect(h.hasDay("2026-09-24")).toBe(false);
    expect(h.state("2026-09-25").records).toHaveLength(1);
    expect(h.chat.sent).toHaveLength(2);
  });

  it("safe cleanup: previous day with PENDING records is kept until delivered", async () => {
    const w = h.watcher();
    await w.check();
    const late = activity("Asha", "Eureka", "23:58");
    h.rows.push(late);
    h.chat.fallback = "500";
    await w.check();
    expect(h.statusOf(late.id)).toBe("pending");

    // Next day, Chat still failing: yesterday's file must survive.
    h.clock = DAY2;
    h.rows = [];
    await w.check();
    expect(h.hasDay("2026-09-24")).toBe(true);

    // Survives a restart too.
    const w2 = h.watcher();
    await w2.check();
    expect(h.hasDay("2026-09-24")).toBe(true);

    // Chat recovers → delivered → then cleaned up.
    h.chat.fallback = "ok";
    h.advance(10 * 60_000);
    await w2.check();
    expect(h.chat.sent).toEqual([`🟢 ${late.message}`]);
    expect(h.hasDay("2026-09-24")).toBe(false);
  });

  it("old files with nothing pending are deleted at startup", async () => {
    const store = new TeamActivityStateStore(dir);
    store.save({ version: 1, date: "2026-09-20", records: [] });
    store.save({ version: 1, date: "2026-09-23", records: [] });
    await h.watcher().check();
    expect(store.listDates()).toEqual(["2026-09-24"]);
  });

  it("corrupted / partial state file → quarantined, no replay, watcher keeps working", async () => {
    h.rows.push(activity("Asha", "Eureka", "09:30"));
    fs.writeFileSync(path.join(dir, "activity-state.json"), '{"version":2,"days":{"2026-09-24":[{"activ');

    const w = h.watcher();
    await w.check();
    expect(h.chat.sent).toEqual([]); // existing activity not replayed
    expect(
      fs.readdirSync(dir).some((f) => f.includes(".corrupt-")),
    ).toBe(true);

    h.rows.push(activity("Ben", "KFH New", "10:55"));
    await w.check();
    expect(h.chat.sent).toHaveLength(1);
  });

  it("state writes are atomic (no temp files left, always valid JSON)", async () => {
    const w = h.watcher();
    await w.check();
    for (let i = 0; i < 20; i++) {
      h.rows.push(activity(`P${i}`, "Eureka", `10:${String(i).padStart(2, "0")}`));
      await w.check();
      expect(() => h.state()).not.toThrow();
    }
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(h.chat.sent).toHaveLength(20);
  });
});
