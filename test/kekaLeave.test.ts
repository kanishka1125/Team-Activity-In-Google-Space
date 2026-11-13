// Leave comes from Keka: a request 12 → 16 gives the leave message on every
// working day in the range. No network: Keka and the Time Tracker are fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RawTimeTrackerEntry } from "../src/integrations/timeTracker/timeTracker.types.js";
import {
  CachedLeaveLookup,
  isWorkingWeekday,
  leaveAnnouncementsOn,
  leavePeopleOn,
} from "../src/services/kekaLeave.service.js";

let trackerRows: RawTimeTrackerEntry[] = [];

vi.mock("../src/integrations/timeTracker/timeTracker.service.js", () => ({
  TimeTrackerService: class {
    async getTimeEntries() {
      return trackerRows;
    }
  },
}));

const employees = [
  { id: "e1", name: "Aniket Kaushik", email: "Aniket@x.com" },
  { id: "e2", name: "Mia", email: "mia@x.com" },
];

const req = (employeeId: string, fromDate: string, toDate: string, fromSession: number, toSession: number, status: number) => ({
  employeeId, fromDate, toDate, fromSession, toSession, status,
});

const work = (name: string, email: string, date: string): RawTimeTrackerEntry => ({
  rowIndex: 1, name, email, project: "Eureka", note: "", startTime: "09:30", endTime: "",
  dateSubmitted: date, totalHours: 0, isOnLeave: false, isAuto: false, actionBy: "",
});

const leaveRow = (name: string, email: string, date: string): RawTimeTrackerEntry => ({
  ...work(name, email, date), project: "On Leave", startTime: "", isOnLeave: true,
});

describe("leave range from Keka", () => {
  const range = [req("e1", "2026-11-12", "2026-11-16", 0, 1, 0)];

  it("covers every day from 12 to 16, and not the days outside it", () => {
    for (const day of ["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"]) {
      expect(leavePeopleOn(day, range, employees).map((p) => p.email)).toEqual(["aniket@x.com"]);
    }

    expect(leavePeopleOn("2026-11-11", range, employees)).toEqual([]);
    expect(leavePeopleOn("2026-11-17", range, employees)).toEqual([]);
  });

  it("only Monday–Friday are working days", () => {
    expect(["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"].map(isWorkingWeekday))
      .toEqual([true, true, false, false, true]);
  });

  it("carries the person's name", () => {
    expect(leavePeopleOn("2026-11-13", range, employees)[0]?.name).toBe("Aniket Kaushik");
  });
});

describe("leaveAnnouncementsOn", () => {
  const D = "2026-11-13";

  it("lists whole-day, first-half-only and second-half-only leave, and nothing for cancelled", () => {
    const list = leaveAnnouncementsOn(D, [
      req("e1", D, D, 0, 1, 0),
      req("e2", D, D, 0, 0, 1),
      req("e3", D, D, 1, 1, 0),
      req("e4", D, D, 0, 1, 4),
    ], [
      { id: "e1", name: "A", email: "a@x.com" }, { id: "e2", name: "B", email: "b@x.com" },
      { id: "e3", name: "C", email: "c@x.com" }, { id: "e4", name: "D", email: "d@x.com" },
    ]);

    expect(list.map((p) => [p.name, p.part])).toEqual([["A", "full"], ["B", "first"], ["C", "second"]]);
  });
});

describe("CachedLeaveLookup", () => {
  it("asks Keka once per period and keeps the last good answer if a refresh fails", async () => {
    let now = 0;
    let fail = false;
    const getLeaveRequests = vi.fn(async () => {
      if (fail) throw new Error("Keka down");
      return [req("e1", "2026-11-13", "2026-11-13", 0, 1, 1)];
    });
    const lookup = new CachedLeaveLookup(
      { getActiveEmployees: async () => employees as never, getLeaveRequests },
      10 * 60_000,
      () => now,
    );

    expect((await lookup.getLeavePeople("2026-11-13")).length).toBe(1);
    now = 60_000;
    await lookup.getLeavePeople("2026-11-13");
    expect(getLeaveRequests).toHaveBeenCalledTimes(1);

    fail = true;
    now = 11 * 60_000;
    expect((await lookup.getLeavePeople("2026-11-13")).length).toBe(1);
    await expect(lookup.getLeavePeople("2026-11-16")).rejects.toThrow("Keka down");
  });
});

describe("Team Activity leave message", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const at = (iso: string) => vi.setSystemTime(new Date(iso));
  const FRI = "2026-11-13T05:00:00Z"; // 10:30 IST
  const SAT = "2026-11-14T05:00:00Z";

  async function service(people: { name: string; email: string }[] | Error) {
    const { TeamActivityService } = await import("../src/services/teamActivity.service.js");

    return new TeamActivityService({
      getLeavePeople: async () => {
        if (people instanceof Error) throw people;
        return people;
      },
    });
  }

  const aniket = { name: "Aniket Kaushik", email: "aniket@x.com" };

  it("announces Keka leave on a working day that has work activity", async () => {
    at(FRI);
    trackerRows = [work("Mia", "mia@x.com", "13-11-2026")];

    const events = await (await service([aniket])).getActivity();

    expect(events.map((e) => e.message)).toEqual([
      "Aniket Kaushik is on leave today",
      "Mia has started working on Eureka at 9:30 AM 😄",
    ]);
    expect(events[0]?.id).toBe("leave-aniket@x.com-2026-11-13");
    expect(events[0]?.dateSubmitted).toBe("13-11-2026");
  });

  it("does not repeat someone the Time Tracker already shows on leave (same id)", async () => {
    at(FRI);
    trackerRows = [work("Mia", "mia@x.com", "13-11-2026"), leaveRow("Aniket Kaushik", "aniket@x.com", "13-11-2026")];

    const events = await (await service([aniket])).getActivity();

    expect(events.filter((e) => e.type === "leave")).toHaveLength(1);
  });

  it("is quiet on a Saturday", async () => {
    at(SAT);
    trackerRows = [work("Mia", "mia@x.com", "14-11-2026")];

    expect((await (await service([aniket])).getActivity()).some((e) => e.type === "leave")).toBe(false);
  });

  it("is quiet on a holiday (no work activity at all)", async () => {
    at(FRI);
    trackerRows = [];

    expect(await (await service([aniket])).getActivity()).toEqual([]);
  });

  it("Keka is the truth: a leave in Keka is announced even if the person has logged work", async () => {
    at(FRI);
    trackerRows = [work("Aniket Kaushik", "aniket@x.com", "13-11-2026")];

    expect((await (await service([aniket])).getActivity()).filter((e) => e.type === "leave")).toHaveLength(1);
  });

  it("half-day leave is announced too, with the half, under the same id as a whole-day leave", async () => {
    at(FRI);
    trackerRows = [work("Mia", "mia@x.com", "13-11-2026")];

    const first = (await (await service([{ ...aniket, part: "first" as const }])).getActivity()).find((e) => e.type === "leave");
    const second = (await (await service([{ ...aniket, part: "second" as const }])).getActivity()).find((e) => e.type === "leave");
    const full = (await (await service([{ ...aniket, part: "full" as const }])).getActivity()).find((e) => e.type === "leave");

    expect(first?.message).toBe("Aniket Kaushik is on half-day leave today (first half)");
    expect(second?.message).toBe("Aniket Kaushik is on half-day leave today (second half)");
    expect(full?.message).toBe("Aniket Kaushik is on leave today");
    expect(new Set([first?.id, second?.id, full?.id]).size).toBe(1);
    expect([first?.icon, second?.icon, full?.icon]).toEqual(["🌗", "🌓", undefined]);
  });

  it("if Keka cannot be read, the normal activity still goes out", async () => {
    at(FRI);
    trackerRows = [work("Mia", "mia@x.com", "13-11-2026")];

    const events = await (await service(new Error("Keka down"))).getActivity();

    expect(events.map((e) => e.name)).toEqual(["Mia"]);
  });
});

describe("leave is never announced twice", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T05:00:00Z"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function svc(people: { name: string; email: string }[]) {
    const { TeamActivityService } = await import("../src/services/teamActivity.service.js");
    return new TeamActivityService({ getLeavePeople: async () => people });
  }

  it("same person under a different email in Keka and the Time Tracker: one message", async () => {
    trackerRows = [work("Mia", "mia@x.com", "13-11-2026"), leaveRow("Aniket Kaushik", "aniket.k@old.com", "13-11-2026")];

    const events = await (await svc([{ name: "Aniket Kaushik", email: "aniket@x.com" }])).getActivity();

    expect(events.filter((e) => e.type === "leave")).toHaveLength(1);
  });

  it("many polls in a row give the same single leave event with the same id", async () => {
    trackerRows = [work("Mia", "mia@x.com", "13-11-2026")];
    const service = await svc([{ name: "Aniket Kaushik", email: "aniket@x.com" }]);

    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      for (const e of await service.getActivity()) if (e.type === "leave") ids.add(e.id);
    }

    expect([...ids]).toEqual(["leave-aniket@x.com-2026-11-13"]);
  });

  it("the Time Tracker leave row and the Keka leave have the SAME id (so the state file sends one)", async () => {
    trackerRows = [work("Mia", "mia@x.com", "13-11-2026"), leaveRow("Aniket Kaushik", "Aniket@X.com", "13-11-2026")];
    const fromTracker = (await (await svc([])).getActivity()).find((e) => e.type === "leave");

    trackerRows = [work("Mia", "mia@x.com", "13-11-2026")];
    const fromKeka = (await (await svc([{ name: "Aniket Kaushik", email: "aniket@x.com" }])).getActivity()).find((e) => e.type === "leave");

    expect(fromKeka?.id).toBe(fromTracker?.id);
  });
});
