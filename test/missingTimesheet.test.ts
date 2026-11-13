// Missing Timesheet report: Time Tracker-only detection, message format,
// "no message when nobody is missing", the weekday 12:00 PM / 3:00 PM IST
// schedule, idempotency, and isolation from the main Space unless it is
// explicitly switched on. Nothing here uses the network or a real Space:
// the Time Tracker is a fake source, time is an injected clock.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  describeMissingTimesheetConfig,
  extractSpaceId,
  parseExcludedEmails,
  parseSendTimes,
  readMissingTimesheetConfig,
} from "../src/config/missingTimesheetConfig.js";
import { leaveEmailsForHalf } from "../src/services/kekaLeave.service.js";
import { GoogleChatService } from "../src/integrations/googleChat/googleChat.service.js";
import type { RawTimeTrackerEntry } from "../src/integrations/timeTracker/timeTracker.types.js";
import {
  MissingTimesheetDataError,
  MissingTimesheetReporter,
  buildMissingTimesheetMessage,
  currentTimeLabel,
  findMissingTimesheets,
  currentHalf,
  leaveEmailsOn,
  missingTimesheetHeader,
  trackerDateKey,
} from "../src/services/missingTimesheet.service.js";
import {
  MissingTimesheetWatcher,
  createMissingTimesheetWatcherFromEnv,
  indiaClock,
  isScheduledDay,
} from "../src/services/missingTimesheetWatcher.service.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

const TODAY = "2026-10-14"; // a Wednesday

// An instant given as India wall-clock time.
function ist(date: string, hh: number, mm: number, ss = 0): Date {
  const [y, m, d] = date.split("-").map(Number);

  return new Date(Date.UTC(y!, m! - 1, d!, hh, mm, ss) - 330 * 60_000);
}

// "2026-10-14" → "14-10-2026" (the Time Tracker's own format)
const dmy = (ymd: string) => ymd.split("-").reverse().join("-");

// A Time Tracker row.
function row(name: string, email: string, date: string, extra: Partial<RawTimeTrackerEntry> = {}): RawTimeTrackerEntry {
  return {
    rowIndex: Math.floor(Math.random() * 1e6),
    name,
    email,
    project: "Some Project",
    note: "",
    startTime: "10:00",
    endTime: "18:00",
    dateSubmitted: dmy(date),
    totalHours: 8,
    isOnLeave: false,
    isAuto: false,
    actionBy: name,
    ...extra,
  };
}

const leave = (name: string, email: string, date: string) =>
  row(name, email, date, { isOnLeave: true, project: "On Leave", startTime: "", endTime: "", totalHours: 0 });

const running = (name: string, email: string, date: string) =>
  row(name, email, date, { endTime: "", totalHours: 0 });

const find = (rows: RawTimeTrackerEntry[], excludedEmails: string[] = []) =>
  findMissingTimesheets({ rows, today: TODAY, excludedEmails });

const missingNames = (r: ReturnType<typeof find>) => r.missing.map((p) => p.name);

let tmp = "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "missing-ts-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------
// Who is missing (Time Tracker only)
// ---------------------------------------------------------------

describe("who is missing a timesheet", () => {
  it("someone who logged recently but has no row today is missing; a started, finished or leave row today is not", () => {
    const rows = [
      row("Missing Mia", "mia@x.com", "2026-10-13"),
      row("Started Sam", "sam@x.com", "2026-10-13"),
      row("Finished Fay", "fay@x.com", "2026-10-13"),
      row("Leave Lee", "lee@x.com", "2026-10-13"),
      // today
      running("Started Sam", "sam@x.com", TODAY),
      row("Finished Fay", "fay@x.com", TODAY),
      leave("Leave Lee", "lee@x.com", TODAY),
      row("Someone Else", "else@x.com", TODAY),
    ];

    expect(missingNames(find(rows))).toEqual(["Missing Mia"]);
  });

  it("a person on leave today is never 'missing' (leave is a reason to have no timesheet)", () => {
    const r = find([row("Lee", "lee@x.com", "2026-10-13"), leave("Lee", "lee@x.com", TODAY), row("Z", "z@x.com", TODAY)]);

    expect(missingNames(r)).toEqual([]);
    expect(r.counts.onLeaveToday).toBe(1);
  });

  it("people whose only recent rows are leave are not expected to log", () => {
    const r = find([leave("Only Leave", "ol@x.com", "2026-10-12"), row("Z", "z@x.com", "2026-10-13"), row("Z", "z@x.com", TODAY)]);

    expect(missingNames(r)).toEqual([]);
    expect(r.counts.people).toBe(1); // only Z has worked recently
  });

  it("'recently' means the last 30 days before today (older work does not count)", () => {
    const rows = [
      row("Thirty Ago", "t30@x.com", "2026-09-14"), // exactly 30 days before
      row("Thirty One Ago", "t31@x.com", "2026-09-13"),
      row("Z", "z@x.com", TODAY),
    ];

    expect(missingNames(find(rows))).toEqual(["Thirty Ago"]);
  });

  it("each person appears once however many rows they have, with their latest name", () => {
    const r = find([
      row("Old Name", "kim@x.com", "2026-10-01"),
      row("Kim L.", "kim@x.com", "2026-10-12"),
      row("Kim", "KIM@x.com ", "2026-10-13"),
      row("Z", "z@x.com", TODAY),
    ]);

    expect(r.missing).toEqual([{ name: "Kim", email: "kim@x.com" }]);
    expect(r.counts.missing).toBe(1);
  });

  it("the list is sorted by name", () => {
    const r = find([
      row("Zed", "zed@x.com", "2026-10-13"),
      row("amy", "amy@x.com", "2026-10-13"),
      row("Bob", "bob@x.com", "2026-10-13"),
      row("Z", "z@x.com", TODAY),
    ]);

    expect(missingNames(r)).toEqual(["amy", "Bob", "Zed"]);
  });

  it("future-dated and unreadable rows are ignored, never counted as 'today' or 'recent'", () => {
    const r = find([
      row("Mia", "mia@x.com", "2026-10-13"),
      row("Future", "future@x.com", "2026-11-10"), // typo'd future date seen in real data
      { ...row("Bad Date", "bad@x.com", TODAY), dateSubmitted: "garbage" },
      { ...row("No Email", "", TODAY) },
      row("Z", "z@x.com", TODAY),
    ]);

    expect(missingNames(r)).toEqual(["Mia"]);
    expect(r.counts.ignoredRows).toBe(2);
    expect(r.counts.rowsToday).toBe(1);
  });

  it("an empty or completely unreadable Time Tracker answer is an error, not 'nobody missing'", () => {
    expect(() => find([])).toThrow(MissingTimesheetDataError);
    expect(() => find([{ ...row("A", "", TODAY) }, { ...row("B", "b@x.com", "nope") }])).toThrow(MissingTimesheetDataError);
  });

  it("no row at all for today (holiday / not updating) builds no list", () => {
    const r = find([row("Mia", "mia@x.com", "2026-10-13"), row("Sam", "sam@x.com", "2026-10-12")]);

    expect(r.noDataToday).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("trackerDateKey reads the Time Tracker date format", () => {
    expect(trackerDateKey("14-10-2026")).toBe("2026-10-14");
    expect(trackerDateKey("4-1-2026")).toBe("2026-01-04");
    expect(trackerDateKey("31-02-2026")).toBeNull();
    expect(trackerDateKey("2026-10-14")).toBeNull();
    expect(trackerDateKey(undefined)).toBeNull();
  });
});

describe("always-excluded emails", () => {
  const rows = [
    row("Anis Ansari", "anis.ansari@intigate.in", "2026-10-13"),
    row("Ravi Yadav", "ravindra.kumar@intigate.in", "2026-10-13"),
    row("Real Missing", "real@x.com", "2026-10-13"),
    row("Z", "z@x.com", TODAY),
  ];

  const excluded = ["anis.ansari@intigate.in", "ravindra.kumar@intigate.in", "tirath.sharma@intigate.in"];

  it("are never listed, and are not counted as people expected to log", () => {
    const r = find(rows, excluded);

    expect(missingNames(r)).toEqual(["Real Missing"]);
    expect(r.counts.excluded).toBe(2);
  });

  it("without the exclusion they would be listed (so the exclusion is what removes them)", () => {
    expect(missingNames(find(rows))).toEqual(["Anis Ansari", "Ravi Yadav", "Real Missing"]);
  });

  it("matching ignores case and spaces; an excluded person who is not in the data is harmless", () => {
    const r = find(rows, [" ANIS.ANSARI@intigate.in ", "not.in.data@x.com"]);

    expect(missingNames(r)).toEqual(["Ravi Yadav", "Real Missing"]);
  });

  it("come from MISSING_TIMESHEET_EXCLUDED_EMAILS", () => {
    const warnings: string[] = [];

    expect(parseExcludedEmails("Anis.Ansari@intigate.in, ravindra.kumar@intigate.in;tirath.sharma@intigate.in, nonsense", warnings)).toEqual([
      "anis.ansari@intigate.in",
      "ravindra.kumar@intigate.in",
      "tirath.sharma@intigate.in",
    ]);
    expect(warnings.join(" ")).toMatch(/not an email address/);
  });
});

// ---------------------------------------------------------------
// Message
// ---------------------------------------------------------------

describe("message format", () => {
  const at = ist(TODAY, 12, 0, 7);

  it("matches the layout exactly", () => {
    expect(buildMissingTimesheetMessage({ names: ["Ben Roe", "Cy Doe"], at, timeLabel: "12:00 PM" })).toBe(
      [
        "🟡 Missing Timesheet — 12:00 PM IST",
        "Date: 14 Oct 2026",
        "",
        "🟡 Ben Roe",
        "🟡 Cy Doe",
        "",
        "Total missing timesheets: 2",
      ].join("\n"),
    );
  });

  it("the header shows the time of the check", () => {
    for (const label of ["12:00 PM", "3:00 PM"]) {
      expect(buildMissingTimesheetMessage({ names: ["X"], at, timeLabel: label }).split("\n")[0]).toBe(`🟡 Missing Timesheet — ${label} IST`);
    }

    expect(missingTimesheetHeader("3:00 PM")).toBe("🟡 Missing Timesheet — 3:00 PM IST");
  });

  it("there is no message to build when nobody is missing", () => {
    expect(() => buildMissingTimesheetMessage({ names: [], at, timeLabel: "12:00 PM" })).toThrow(MissingTimesheetDataError);
  });

  it("uses the India date even when it is a different day in UTC", () => {
    expect(buildMissingTimesheetMessage({ names: ["X"], at: new Date("2026-10-13T20:00:00Z"), timeLabel: "12:00 PM" })).toContain("Date: 14 Oct 2026");
  });

  it("a manual run labels the header with the actual current India time", () => {
    expect(currentTimeLabel(new Date("2026-10-14T06:19:51Z"))).toBe("11:49 AM");
    expect(currentTimeLabel(new Date("2026-10-14T09:30:00Z"))).toBe("3:00 PM");
  });

  it("a list too long for one Google Chat message is an error, never silently cut", () => {
    const many = Array.from({ length: 400 }, (_, i) => `Employee Number ${i}`);

    expect(() => buildMissingTimesheetMessage({ names: many, at, timeLabel: "12:00 PM" })).toThrow(/too long/);
  });
});

// ---------------------------------------------------------------
// Reporter: Time Tracker in, message (or nothing) out
// ---------------------------------------------------------------

function reporterFor(rows: RawTimeTrackerEntry[] | Error, excluded: string[] = [], at = ist(TODAY, 12, 0, 7)) {
  const calls = { count: 0 };

  const reporter = new MissingTimesheetReporter(
    {
      getData: async () => {
        calls.count++;
        if (rows instanceof Error) throw rows;
        return rows;
      },
    },
    () => at,
    excluded,
  );

  return { reporter, calls };
}

describe("reporter", () => {
  it("builds the message with the scheduled time label", async () => {
    const { reporter } = reporterFor([row("Mia", "mia@x.com", "2026-10-13"), row("Z", "z@x.com", TODAY)]);

    const report = await reporter.buildReport({ timeLabel: "3:00 PM" });

    expect(report.message).toBe(
      ["🟡 Missing Timesheet — 3:00 PM IST", "Date: 14 Oct 2026", "", "🟡 Mia", "", "Total missing timesheets: 1"].join("\n"),
    );
    expect(report.reason).toBe("");
  });

  it("NOBODY missing → no message at all (message is null, never an empty message)", async () => {
    const { reporter } = reporterFor([row("Mia", "mia@x.com", "2026-10-13"), row("Mia", "mia@x.com", TODAY)]);

    const report = await reporter.buildReport({ timeLabel: "12:00 PM" });

    expect(report.message).toBeNull();
    expect(report.reason).toBe("nobody_missing");
    expect(report.names).toEqual([]);
  });

  it("no row at all for today → no message", async () => {
    const { reporter } = reporterFor([row("Mia", "mia@x.com", "2026-10-13")]);

    const report = await reporter.buildReport();

    expect(report.message).toBeNull();
    expect(report.reason).toBe("no_data_today");
  });

  it("excluded people never appear, and if that leaves nobody there is no message", async () => {
    const rows = [row("Boss", "boss@x.com", "2026-10-13"), row("Z", "z@x.com", TODAY)];

    expect((await reporterFor(rows).reporter.buildReport()).names).toEqual(["Boss"]);

    const excluded = await reporterFor(rows, ["boss@x.com"]).reporter.buildReport();
    expect(excluded.message).toBeNull();
  });

  it("a Time Tracker failure throws: no message, nothing guessed", async () => {
    await expect(reporterFor(new Error("Time Tracker API did not respond within 30 seconds")).reporter.buildReport()).rejects.toThrow(/Time Tracker/);
    await expect(reporterFor([]).reporter.buildReport()).rejects.toThrow(MissingTimesheetDataError);
  });

  it("a manual run (no label) uses the actual current time in the header", async () => {
    const { reporter } = reporterFor([row("Mia", "mia@x.com", "2026-10-13"), row("Z", "z@x.com", TODAY)], [], ist(TODAY, 11, 49, 51));

    expect((await reporter.buildReport()).message?.split("\n")[0]).toBe("🟡 Missing Timesheet — 11:49 AM IST");
  });
});

describe("only the Time Tracker is used", () => {
  it("the Missing Timesheet code has no PMS / Keka / Team Activity / unallocated dependency", () => {
    const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    for (const file of [
      "src/services/missingTimesheet.service.ts",
      "src/services/missingTimesheetWatcher.service.ts",
      "src/config/missingTimesheetConfig.ts",
      "scripts/missing-timesheet.mjs",
    ]) {
      const code = strip(fs.readFileSync(path.join(root, file), "utf8"));

      expect(code, file).not.toMatch(/\bpms\b|PMS_|pms\.client|pmsRules/i);
      // Keka is allowed ONLY for reading leave, in the service file.
      if (file !== "src/services/missingTimesheet.service.ts") {
        expect(code, file).not.toMatch(/keka/i);
      }
      expect(code, file).not.toMatch(/unallocated|teamActivity|team-activity/i);

      // Only the config may mention the main webhook, and only to choose/refuse it.
      if (file !== "src/config/missingTimesheetConfig.ts") {
        expect(code, file).not.toMatch(/GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL/);
      }
    }
  });

  it("the old PMS-based Free Resources feature is gone", () => {
    for (const file of [
      "src/services/freeResources.service.ts",
      "src/services/freeResourcesWatcher.service.ts",
      "src/config/freeResourcesConfig.ts",
      "scripts/free-resources.mjs",
    ]) {
      expect(fs.existsSync(path.join(root, file)), file).toBe(false);
    }

    const server = fs.readFileSync(path.join(root, "src/server.ts"), "utf8");
    expect(server).not.toMatch(/freeResources|FreeResources|FREE_RESOURCES/);
  });
});

// ---------------------------------------------------------------
// Schedule: Monday-Friday at 12:00 PM and 3:00 PM India time
// ---------------------------------------------------------------

const SLOTS = parseSendTimes(undefined);

type ReportShape = { message: string | null; reason?: "" | "nobody_missing" | "no_data_today" };

function watcherFor(options: {
  now: { at: Date };
  stateFile?: string;
  slots?: typeof SLOTS;
  build?: (label?: string) => Promise<ReportShape>;
  send?: (message: string) => Promise<void>;
}) {
  const sent: string[] = [];
  const built = { count: 0, labels: [] as (string | undefined)[] };

  const watcher = new MissingTimesheetWatcher({
    now: () => options.now.at,
    stateFile: options.stateFile ?? path.join(tmp, "state.json"),
    slots: options.slots ?? SLOTS,
    reporter: {
      buildReport: async (o) => {
        built.count++;
        built.labels.push(o?.timeLabel);

        const r: ReportShape = options.build ? await options.build(o?.timeLabel) : { message: `LIST ${o?.timeLabel}` };

        return {
          message: r.message,
          reason: r.reason ?? (r.message === null ? "nobody_missing" : ""),
          names: r.message === null ? [] : ["A"],
          result: {
            today: TODAY,
            missing: [],
            noDataToday: r.reason === "no_data_today",
            counts: { rows: 1, ignoredRows: 0, rowsToday: 1, people: 1, onLeaveToday: 0, excluded: 0, missing: r.message === null ? 0 : 1 },
          },
          retrievedAt: options.now.at,
        };
      },
    },
    send:
      options.send ??
      (async (message) => {
        sent.push(message);
      }),
  });

  return { watcher, sent, built };
}

// Runs a whole day in 5-minute steps.
async function runDay(day: string, watcherOpts: Partial<Parameters<typeof watcherFor>[0]> = {}) {
  const now = { at: ist(day, 0, 0) };
  const w = watcherFor({ now, stateFile: path.join(tmp, `${day}.json`), ...watcherOpts });

  for (let minutes = 0; minutes < 24 * 60; minutes += 5) {
    now.at = ist(day, Math.floor(minutes / 60), minutes % 60);
    await w.watcher.check();
  }

  return w;
}

describe("schedule: Monday-Friday at 12:00 PM and 3:00 PM India time", () => {
  it("the default times are exactly 12:00 PM and 3:00 PM", () => {
    expect(SLOTS.map((s) => s.key)).toEqual(["12:00", "15:00"]);
    expect(SLOTS.map((s) => s.label)).toEqual(["12:00 PM", "3:00 PM"]);
    expect(readMissingTimesheetConfig({} as NodeJS.ProcessEnv).sendTimes).toEqual(SLOTS);
  });

  it("the test calendar is what we think it is (Mon 12 Oct 2026 … Sun 18 Oct 2026)", () => {
    const days = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];

    expect(days.map((d) => indiaClock(ist(d, 12, 0)).dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(days.map((d) => isScheduledDay(indiaClock(ist(d, 12, 0)).dayOfWeek))).toEqual([true, true, true, true, true, false, false]);
  });

  it("each of Monday-Friday gets exactly two messages when people are missing: 12:00 PM and 3:00 PM", async () => {
    for (const day of ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]) {
      const { sent, built } = await runDay(day);

      expect(sent, day).toEqual(["LIST 12:00 PM", "LIST 3:00 PM"]);
      expect(built.labels, day).toEqual(["12:00 PM", "3:00 PM"]);
    }
  });

  it("each check happens at its own time, not before", async () => {
    const now = { at: ist(TODAY, 11, 59, 59) };
    const { watcher, sent } = watcherFor({ now });

    const at = async (h: number, m: number, s: number) => {
      now.at = ist(TODAY, h, m, s);
      await watcher.check();
      return [...sent];
    };

    expect(await at(11, 59, 59)).toEqual([]);
    expect(await at(12, 0, 0)).toEqual(["LIST 12:00 PM"]);
    expect(await at(14, 59, 59)).toEqual(["LIST 12:00 PM"]);
    expect(await at(15, 0, 0)).toEqual(["LIST 12:00 PM", "LIST 3:00 PM"]);
    expect(await at(17, 0, 0)).toEqual(["LIST 12:00 PM", "LIST 3:00 PM"]); // nothing else later
    expect(await at(23, 59, 0)).toHaveLength(2);
  });

  it("never runs on Saturday or Sunday, at any time of day, and never even reads the Time Tracker", async () => {
    for (const day of ["2026-10-17", "2026-10-18"]) {
      const { sent, built } = await runDay(day);

      expect(sent, day).toEqual([]);
      expect(built.count, day).toBe(0);
    }
  });

  it("follows India time, not UTC: Friday evening UTC is already Saturday in India", async () => {
    const now = { at: new Date("2026-10-16T20:00:00Z") }; // Sat 01:30 IST

    expect(indiaClock(now.at)).toMatchObject({ date: "2026-10-17", dayOfWeek: 6 });

    const { watcher, sent } = watcherFor({ now });
    await watcher.check();
    expect(sent).toEqual([]);

    now.at = new Date("2026-10-19T06:30:00Z"); // Monday 12:00 IST
    await watcher.check();
    expect(sent).toEqual(["LIST 12:00 PM"]);
  });

  it("registers the schedule only once even if start() is called again", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const { watcher } = watcherFor({ now: { at: ist("2026-10-17", 9, 0) } }); // Saturday

    watcher.start(60_000);
    watcher.start(60_000);
    watcher.start(60_000);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(watcher.getStatus()).toMatchObject({ scheduled: true, times: ["12:00 PM", "3:00 PM"] });

    watcher.stop();
    expect(watcher.getStatus().scheduled).toBe(false);
  });
});

describe("no message when nobody is missing", () => {
  const nobody = async (): Promise<ReportShape> => ({ message: null, reason: "nobody_missing" });

  it("a slot with nobody missing posts nothing, is finished, and is not re-read all window", async () => {
    const now = { at: ist(TODAY, 12, 0, 0) };
    const { watcher, sent, built } = watcherFor({ now, build: nobody });

    for (let i = 0; i < 30; i++) {
      now.at = new Date(now.at.getTime() + 10_000);
      await watcher.check();
    }

    expect(sent).toEqual([]);
    expect(built.count).toBe(1);
    expect(watcher.getStatus().nothingToSendToday).toEqual(["12:00 PM"]);
    expect(watcher.getStatus().sentToday).toEqual([]);
  });

  it("a whole day with nobody missing posts nothing at all", async () => {
    const { sent, built } = await runDay(TODAY, { build: nobody });

    expect(sent).toEqual([]);
    expect(built.count).toBe(2); // one read per slot
  });

  it("no row at all today (holiday) posts nothing", async () => {
    const { sent } = await runDay(TODAY, { build: async () => ({ message: null, reason: "no_data_today" }) });

    expect(sent).toEqual([]);
  });

  it("the 12:00 check finding nobody does not stop the 3:00 PM check from posting if people are missing then", async () => {
    let call = 0;
    const { sent } = await runDay(TODAY, {
      build: async (label) => (call++ === 0 ? { message: null, reason: "nobody_missing" } : { message: `LIST ${label}` }),
    });

    expect(sent).toEqual(["LIST 3:00 PM"]);
  });

  it("a restart after a 'nothing to send' check does not re-check that slot", async () => {
    const stateFile = path.join(tmp, "state.json");
    const now = { at: ist(TODAY, 12, 0, 0) };

    await watcherFor({ now, stateFile, build: nobody }).watcher.check();

    now.at = ist(TODAY, 12, 5, 0);
    const second = watcherFor({ now, stateFile, build: nobody });
    await second.watcher.check();

    expect(second.built.count).toBe(0);
  });
});

describe("no duplicate messages", () => {
  it("repeated checks send each slot once", async () => {
    const now = { at: ist(TODAY, 12, 0, 0) };
    const { watcher, sent } = watcherFor({ now });

    for (let i = 0; i < 30; i++) {
      now.at = new Date(now.at.getTime() + 10_000);
      await watcher.check();
    }

    expect(sent).toEqual(["LIST 12:00 PM"]);
  });

  it("overlapping checks send one message", async () => {
    const now = { at: ist(TODAY, 12, 0, 0) };
    const { watcher, sent } = watcherFor({
      now,
      build: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { message: "LIST" };
      },
    });

    await Promise.all([watcher.check(), watcher.check(), watcher.check()]);

    expect(sent).toEqual(["LIST"]);
  });

  it("a restart within the same day does not repeat a slot already sent, but the next slot still goes out", async () => {
    const stateFile = path.join(tmp, "state.json");
    const now = { at: ist(TODAY, 12, 0, 0) };

    const first = watcherFor({ now, stateFile });
    await first.watcher.check();
    expect(first.sent).toEqual(["LIST 12:00 PM"]);

    now.at = ist(TODAY, 12, 5, 0);
    const second = watcherFor({ now, stateFile });
    await second.watcher.check();
    expect(second.sent).toEqual([]);
    expect(second.built.count).toBe(0);

    now.at = ist(TODAY, 15, 0, 0);
    await second.watcher.check();
    expect(second.sent).toEqual(["LIST 3:00 PM"]);

    expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).days[TODAY].sent).toEqual(["12:00", "15:00"]);
  });

  it("the next weekday sends again", async () => {
    const stateFile = path.join(tmp, "state.json");
    const now = { at: ist(TODAY, 12, 0, 0) };
    const { watcher, sent } = watcherFor({ now, stateFile });

    await watcher.check();
    now.at = ist("2026-10-15", 12, 0, 0);
    await watcher.check();

    expect(sent).toEqual(["LIST 12:00 PM", "LIST 12:00 PM"]);
  });

  it("a restart after a slot's 30 minutes does not run that slot late", async () => {
    const now = { at: ist(TODAY, 12, 40, 0) };
    const { watcher, sent, built } = watcherFor({ now });

    await watcher.check();
    expect(sent).toEqual([]);
    expect(built.count).toBe(0);

    now.at = ist(TODAY, 15, 0, 0);
    await watcher.check();
    expect(sent).toEqual(["LIST 3:00 PM"]);
  });

  it("old days are pruned from the state file", async () => {
    const stateFile = path.join(tmp, "state.json");
    const days: Record<string, { sent: string[]; nothingToSend: string[] }> = {};
    for (let d = 1; d <= 9; d++) days[`2026-09-${String(d).padStart(2, "0")}`] = { sent: ["12:00"], nothingToSend: [] };
    fs.writeFileSync(stateFile, JSON.stringify({ days }));

    await watcherFor({ now: { at: ist(TODAY, 12, 0, 0) }, stateFile }).watcher.check();

    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(Object.keys(saved.days).length).toBeLessThanOrEqual(7);
    expect(Object.keys(saved.days)).toContain(TODAY);
  });
});

describe("failures and retries (nothing is ever posted about a failure)", () => {
  it("Time Tracker failure: nothing is sent, it retries after a minute, then sends once", async () => {
    const now = { at: ist(TODAY, 12, 0, 0) };
    let calls = 0;
    const { watcher, sent } = watcherFor({
      now,
      build: async () => {
        calls++;
        if (calls === 1) throw new Error("Time Tracker API did not respond within 30 seconds");
        return { message: "LIST" };
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await watcher.check();
    expect(sent).toEqual([]);
    expect(watcher.getStatus().failedAttemptsToday).toBe(1);

    now.at = ist(TODAY, 12, 0, 30); // inside the retry pause
    await watcher.check();
    expect(calls).toBe(1);

    now.at = ist(TODAY, 12, 1, 5);
    await watcher.check();
    expect(sent).toEqual(["LIST"]);
    expect(watcher.getStatus().failedAttemptsToday).toBe(0);
  });

  it("Google Chat failure retries and still sends exactly once when it recovers", async () => {
    const now = { at: ist(TODAY, 12, 0, 0) };
    let tries = 0;
    const delivered: string[] = [];
    const { watcher } = watcherFor({
      now,
      send: async (m) => {
        tries++;
        if (tries === 1) throw new Error("Google Chat webhook failed: 429");
        delivered.push(m);
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await watcher.check();
    now.at = ist(TODAY, 12, 2, 0);
    await watcher.check();
    now.at = ist(TODAY, 12, 3, 0);
    await watcher.check();

    expect(delivered).toEqual(["LIST 12:00 PM"]);
  });

  it("if the Time Tracker stays down for a slot's 30 minutes: NOTHING is posted (no list, no notice), it is logged once", async () => {
    const now = { at: ist(TODAY, 12, 0, 0) };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { watcher, sent } = watcherFor({
      now,
      slots: parseSendTimes("12:00"),
      build: async () => {
        throw new Error("Time Tracker API request failed: 500");
      },
    });

    await watcher.check();
    now.at = ist(TODAY, 12, 15, 0);
    await watcher.check();
    now.at = ist(TODAY, 12, 31, 0);
    await watcher.check();
    await watcher.check();
    now.at = ist(TODAY, 13, 30, 0);
    await watcher.check();

    expect(sent).toEqual([]);
    expect(errors.mock.calls.filter((c) => String(c[0]).includes("was NOT checked")).length).toBe(1);
  });

  it("a failing slot does not block the next slot", async () => {
    const now = { at: ist(TODAY, 12, 0, 0) };
    let current = "12:00 PM";
    const { watcher, sent } = watcherFor({
      now,
      build: async () => {
        if (current === "12:00 PM") throw new Error("Time Tracker could not be reached");
        return { message: `LIST ${current}` };
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await watcher.check();
    now.at = ist(TODAY, 12, 40, 0);
    await watcher.check();
    current = "3:00 PM";
    now.at = ist(TODAY, 15, 0, 0);
    await watcher.check();

    expect(sent).toEqual(["LIST 3:00 PM"]);
  });
});

// ---------------------------------------------------------------
// Destination: the main Space only when explicitly switched on
// ---------------------------------------------------------------

const MAIN = "https://chat.googleapis.com/v1/spaces/MAINSPACE1/messages?key=mainkey&token=maintoken";
const TEST = "https://chat.googleapis.com/v1/spaces/TESTSPACE2/messages?key=testkey&token=testtoken";

describe("destination", () => {
  const read = (env: Record<string, string>) => readMissingTimesheetConfig(env as NodeJS.ProcessEnv);

  it("extracts the Space id and rejects anything that is not a Google Chat webhook", () => {
    expect(extractSpaceId(TEST)).toBe("TESTSPACE2");
    expect(extractSpaceId("http://chat.googleapis.com/v1/spaces/X/messages")).toBeNull();
    expect(extractSpaceId("https://evil.example/v1/spaces/X/messages")).toBeNull();
    expect(extractSpaceId("nonsense")).toBeNull();
  });

  it("is off by default and has no destination without its own webhook", () => {
    const c = read({});

    expect(c.scheduleEnabled).toBe(false);
    expect(c.destination).toBeNull();
  });

  it("never falls back to the main Space's webhook", () => {
    expect(read({ GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL: MAIN, MISSING_TIMESHEET_SCHEDULE_ENABLED: "true" }).destination).toBeNull();
  });

  it("refuses a 'testing' webhook that belongs to the main Space", () => {
    for (const hook of [MAIN, "https://chat.googleapis.com/v1/spaces/MAINSPACE1/messages?key=o&token=o"]) {
      const c = read({ GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL: MAIN, MISSING_TIMESHEET_WEBHOOK_URL: hook });

      expect(c.destination).toBeNull();
      expect(c.problems.join(" ")).toMatch(/MAIN Space/);
    }
  });

  it("the flag makes the MAIN Space the destination, with the main webhook only", () => {
    const c = read({
      MISSING_TIMESHEET_POST_TO_MAIN_SPACE: "true",
      GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL: MAIN,
      MISSING_TIMESHEET_WEBHOOK_URL: TEST, // ignored in this mode
    });

    expect(c.destination).toMatchObject({ kind: "main", spaceId: "MAINSPACE1", webhookUrl: MAIN });
  });

  it("anything that is not clearly true does not switch the main Space on", () => {
    for (const value of ["", "false", "no", "maybe", "main", "tru"]) {
      expect(read({ MISSING_TIMESHEET_POST_TO_MAIN_SPACE: value, GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL: MAIN }).destination, value).toBeNull();
    }
  });

  it("the flag with no main webhook means no destination (no fallback to the testing one)", () => {
    expect(read({ MISSING_TIMESHEET_POST_TO_MAIN_SPACE: "true", MISSING_TIMESHEET_WEBHOOK_URL: TEST }).destination).toBeNull();
  });

  it("the expected Space id is checked in both modes", () => {
    const main = { MISSING_TIMESHEET_POST_TO_MAIN_SPACE: "true", GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL: MAIN };

    expect(read({ ...main, MISSING_TIMESHEET_EXPECTED_SPACE_ID: "MAINSPACE1" }).destination?.kind).toBe("main");
    expect(read({ ...main, MISSING_TIMESHEET_EXPECTED_SPACE_ID: "TESTSPACE2" }).destination).toBeNull();
    expect(read({ MISSING_TIMESHEET_WEBHOOK_URL: TEST, MISSING_TIMESHEET_EXPECTED_SPACE_ID: "OTHER" }).destination).toBeNull();
  });

  it("send times can be set, are sorted and validated; times closer than the retry window are refused", () => {
    expect(parseSendTimes("17:00, 9:30, 17:00,12:05").map((s) => s.label)).toEqual(["9:30 AM", "12:05 PM", "5:00 PM"]);

    const warnings: string[] = [];
    expect(parseSendTimes("12:00,12:10,13:00", warnings).map((s) => s.key)).toEqual(["12:00", "13:00"]);
    expect(parseSendTimes("nonsense").map((s) => s.key)).toEqual(["12:00", "15:00"]);
  });

  it("the start-up log line says which Space and never prints the webhook, key or token", () => {
    const line = describeMissingTimesheetConfig({
      MISSING_TIMESHEET_SCHEDULE_ENABLED: "true",
      MISSING_TIMESHEET_POST_TO_MAIN_SPACE: "true",
      GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL: MAIN,
    } as NodeJS.ProcessEnv);

    expect(line).toContain("the MAIN Space");
    expect(line).toContain("12:00 PM, 3:00 PM");
    expect(line).not.toMatch(/mainkey|maintoken|key=|token=|chat\.googleapis/);
  });

  it("the schedule is built only when switched on AND the destination is safe", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("TIME_TRACKER_API_URL", "https://tt.example/exec");

    const make = (env: Record<string, string>) => createMissingTimesheetWatcherFromEnv(env as NodeJS.ProcessEnv);

    expect(make({})).toBeNull();
    expect(make({ MISSING_TIMESHEET_SCHEDULE_ENABLED: "true" })).toBeNull();
    expect(make({ MISSING_TIMESHEET_SCHEDULE_ENABLED: "true", GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL: MAIN })).toBeNull();
    expect(make({ MISSING_TIMESHEET_SCHEDULE_ENABLED: "true", GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL: MAIN, MISSING_TIMESHEET_WEBHOOK_URL: TEST })).not.toBeNull();
    expect(make({ MISSING_TIMESHEET_SCHEDULE_ENABLED: "true", GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL: MAIN, MISSING_TIMESHEET_POST_TO_MAIN_SPACE: "true" })).not.toBeNull();

    vi.unstubAllEnvs();
  });

  it("the send method posts only to the webhook it is given, never to the main one", async () => {
    vi.stubEnv("GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL", MAIN);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await new GoogleChatService().sendMissingTimesheetMessage(TEST, "hello");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(TEST);

    vi.unstubAllEnvs();
  });
});

// ---------------------------------------------------------------
// Keka leave: people on leave are never listed
// ---------------------------------------------------------------

describe("Keka leave", () => {
  const employees = [
    { id: "e1", email: "Anam@x.com" },
    { id: "e2", email: "aniket@x.com" },
    { id: "e3", email: "half@x.com" },
  ];
  const D = "2026-10-14";
  const req = (employeeId: string, fromDate: string, toDate: string, fromSession: number, toSession: number, status: number) => ({
    employeeId, fromDate, toDate, fromSession, toSession, status,
  });

  it("pending and approved full-day / multi-day leave count; rejected or cancelled do not", () => {
    const set = leaveEmailsOn(D, [
      req("e1", D, D, 0, 1, 0),
      req("e2", "2026-10-13", D, 0, 1, 1),
      req("e3", D, D, 0, 1, 3),
    ], employees);

    expect([...set].sort()).toEqual(["anam@x.com", "aniket@x.com"]);
  });

  it("a lone half day is not leave, two halves together are", () => {
    expect(leaveEmailsOn(D, [req("e3", D, D, 0, 0, 1)], employees).size).toBe(0);
    expect([...leaveEmailsOn(D, [req("e3", D, D, 0, 0, 1), req("e3", D, D, 1, 1, 0)], employees)]).toEqual(["half@x.com"]);
  });

  it("a request starting in the second half of its first day does not cover that whole day", () => {
    expect(leaveEmailsOn(D, [req("e1", D, "2026-10-15", 1, 1, 1)], employees).size).toBe(0);
  });

  it("someone on leave in Keka is not listed even without a Time Tracker leave row", async () => {
    const rows = [
      row("Mia", "mia@x.com", "2026-10-13"),
      row("Anam", "anam@x.com", "2026-10-13"),
      row("Z", "z@x.com", TODAY),
    ];

    const reporter = new MissingTimesheetReporter(
      { getData: async () => rows },
      () => ist(TODAY, 12, 0, 7),
      [],
      { getLeaveEmails: async () => new Set(["anam@x.com"]) },
    );

    expect((await reporter.buildReport({ timeLabel: "12:00 PM" })).names).toEqual(["Mia"]);
  });

  it("if Keka cannot be read, nothing is built (no guessed list)", async () => {
    const reporter = new MissingTimesheetReporter(
      { getData: async () => [row("Mia", "mia@x.com", "2026-10-13"), row("Z", "z@x.com", TODAY)] },
      () => ist(TODAY, 12, 0, 7),
      [],
      { getLeaveEmails: async () => { throw new Error("Keka down"); } },
    );

    await expect(reporter.buildReport()).rejects.toThrow("Keka down");
  });
});

describe("half-day leave in the missing timesheet", () => {
  const employees = [{ id: "e1", email: "half@x.com" }];
  const D = "2026-10-14";
  const half = (from: number, to: number) => [{ employeeId: "e1", fromDate: D, toDate: D, fromSession: from, toSession: to, status: 0 }];

  it("first-half leave excuses the 12 PM check only; second-half leave excuses the 3 PM check only; full day both", () => {
    expect(leaveEmailsForHalf(D, 0, half(0, 0), employees).size).toBe(1);
    expect(leaveEmailsForHalf(D, 1, half(0, 0), employees).size).toBe(0);
    expect(leaveEmailsForHalf(D, 0, half(1, 1), employees).size).toBe(0);
    expect(leaveEmailsForHalf(D, 1, half(1, 1), employees).size).toBe(1);
    expect(leaveEmailsForHalf(D, 0, half(0, 1), employees).size).toBe(1);
    expect(leaveEmailsForHalf(D, 1, half(0, 1), employees).size).toBe(1);
  });

  it("the check at 12:00 is the first half, at 15:00 the second half", () => {
    expect(currentHalf(ist(TODAY, 12, 0, 7))).toBe(0);
    expect(currentHalf(ist(TODAY, 13, 59, 0))).toBe(0);
    expect(currentHalf(ist(TODAY, 14, 0, 0))).toBe(1);
    expect(currentHalf(ist(TODAY, 15, 0, 7))).toBe(1);
  });

  it("a first-half-leave person is skipped at 12 PM but listed at 3 PM if they have not logged", async () => {
    const rows = [row("Mia", "mia@x.com", "2026-10-13"), row("Hana", "hana@x.com", "2026-10-13"), row("Z", "z@x.com", TODAY)];
    const source = { getLeaveEmails: async (_d: string, h: number) => new Set(h === 0 ? ["hana@x.com"] : []) };
    const at = (h: number) => new MissingTimesheetReporter({ getData: async () => rows }, () => ist(TODAY, h, 0, 7), [], source);

    expect((await at(12).buildReport({ timeLabel: "12:00 PM" })).names).toEqual(["Mia"]);
    expect((await at(15).buildReport({ timeLabel: "3:00 PM" })).names).toEqual(["Hana", "Mia"]);
  });
});
