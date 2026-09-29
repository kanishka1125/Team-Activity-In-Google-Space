import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Replace only the Time Tracker fetch; everything else is real.
const rows: Array<Record<string, unknown>> = [];
vi.mock("../src/integrations/timeTracker/timeTracker.service.js", () => ({
  TimeTrackerService: class {
    async getTimeEntries() {
      return rows.map((r) => ({ ...r }));
    }
  },
}));

const { TeamActivityService } = await import("../src/services/teamActivity.service.js");

const today = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
})
  .format(new Date())
  .replaceAll("/", "-");

function row(rowIndex: number, name: string, project: string, startTime: string, extra: Record<string, unknown> = {}) {
  return {
    rowIndex,
    name,
    email: `${name.toLowerCase()}@x.in`,
    project,
    note: "",
    startTime,
    endTime: "",
    dateSubmitted: today,
    totalHours: 0,
    isOnLeave: false,
    isAuto: false,
    actionBy: "",
    ...extra,
  };
}

let warns: string[];

beforeEach(() => {
  rows.length = 0;
  warns = [];
  vi.spyOn(console, "warn").mockImplementation((...a) => void warns.push(a.map(String).join(" ")));
});

afterEach(() => vi.restoreAllMocks());

describe("9. Time Tracker date/time validation", () => {
  it("rows with unreadable date/time create no activity, are warned about once, valid rows still work", async () => {
    const service = new TeamActivityService();

    rows.push(row(2, "Asha", "Eureka", "9:30"));
    await service.getActivity(); // first load

    rows.push(
      row(3, "Ben", "KFH New", "abc"), // bad time
      row(4, "Cara", "RVVPL", "25:99"), // impossible time
      row(5, "Dev", "Li3ib", "10:40", { dateSubmitted: "2026/09/24" }), // bad date format
      row(6, "Esha", "Suffix", "10:41", { dateSubmitted: "31-02-2026" }), // impossible date
      row(7, "Lina", "", "", { isOnLeave: true }), // leave: empty time is normal
      row(8, "Asha", "Li3ib", "10:45"), // valid switch
    );

    const events = await service.getActivity();
    const names = events.map((e) => e.name);

    expect(names).not.toContain("Ben");
    expect(names).not.toContain("Cara");
    expect(names).not.toContain("Dev");
    expect(names).not.toContain("Esha");
    expect(names).toContain("Lina");
    expect(events.find((e) => e.name === "Asha" && e.project === "Li3ib")?.message).toBe(
      "Asha switched to Li3ib from Eureka at 10:45 AM",
    );

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("skipped 4 Time Tracker row(s)");
    expect(warns[0]).toContain('row 3 (Ben): unreadable startTime "abc"');

    // Same bad rows on later polls → no repeated warnings.
    await service.getActivity();
    await service.getActivity();
    expect(warns).toHaveLength(1);
  });

  it("an invalid row is never used as someone's 'previous project'", async () => {
    const service = new TeamActivityService();
    rows.push(row(2, "Asha", "Eureka", "9:30"));
    await service.getActivity();
    rows.push(row(3, "Asha", "Ghost", "xx:yy"), row(4, "Asha", "Li3ib", "10:45"));
    const events = await service.getActivity();
    const msg = events.find((e) => e.project === "Li3ib")?.message;
    expect(msg).toBe("Asha switched to Li3ib from Eureka at 10:45 AM");
    expect(events.some((e) => e.project === "Ghost")).toBe(false);
  });
});
