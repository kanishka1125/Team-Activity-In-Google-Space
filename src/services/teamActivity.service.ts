import { TimeTrackerService } from "../integrations/timeTracker/timeTracker.service.js";
import type { RawTimeTrackerEntry } from "../integrations/timeTracker/timeTracker.types.js";
import {
  createCachedLeaveLookupFromEnv,
  isWorkingWeekday,
  type LeaveLookup,
} from "./kekaLeave.service.js";

export type TeamActivityType =
  | "login"
  | "project_change"
  | "leave";

export interface TeamActivityEvent {
  id: string;
  type: TeamActivityType;
  name: string;
  email: string;
  project: string;
  // Project the person switched FROM (project_change only).
  previousProject: string | null;
  startTime: string;
  dateSubmitted: string;
  totalHours: number;
  message: string;
  // Emoji shown in front of the message; the sender's default when absent
  // (red circle for leave, green for work).
  icon?: string;
}

export class TeamActivityService {
  private readonly timeTrackerService: TimeTrackerService;

  private previousRows = new Map<string, RawTimeTrackerEntry>();
  private activityEvents: TeamActivityEvent[] = [];
  private currentDay = "";

  // Rows already reported as unreadable (warn once per row per day).
  private reportedInvalidRows = new Set<string>();

  // Leave comes from Keka: a request such as 12 → 16 gives the leave message
  // on every working day in the range (Keka, not the Time Tracker, is the
  // source; Time Tracker leave rows still work and are never duplicated).
  private readonly leaveLookup: LeaveLookup | null;
  private lastLeaveWarningAt = 0;

  // `leaveLookup`: omit to use Keka from the environment (none when Keka is
  // not configured); pass null to turn Keka leave off.
  constructor(leaveLookup?: LeaveLookup | null) {
    this.timeTrackerService = new TimeTrackerService();
    this.leaveLookup =
      leaveLookup === undefined ? createCachedLeaveLookupFromEnv() : leaveLookup;
  }

  async getActivity(): Promise<TeamActivityEvent[]> {
    return this.withKekaLeave(await this.getTrackerActivity());
  }

  // Adds "X is on leave today" (or "half-day leave", first/second half) for
  // everyone Keka shows on leave today who has no leave event yet. Whole-day
  // and half-day leave share ONE id per person per day, so a person is never
  // announced twice, whichever source reports it first. Only on working days (Mon–Fri) that have real work
  // activity, so weekends and holidays stay quiet. If Keka cannot be read,
  // the normal activity still goes out.
  private async withKekaLeave(
    events: TeamActivityEvent[],
  ): Promise<TeamActivityEvent[]> {
    const today = this.getToday();

    if (
      !this.leaveLookup ||
      !isWorkingWeekday(today) ||
      !events.some((event) => event.type !== "leave")
    ) {
      return events;
    }

    let people;

    try {
      people = await this.leaveLookup.getLeavePeople(today);
    } catch (error) {
      if (Date.now() - this.lastLeaveWarningAt > 5 * 60_000) {
        this.lastLeaveWarningAt = Date.now();

        console.warn(
          `Team Activity: Keka leave could not be read (${error instanceof Error ? error.message : String(error)}); leave from Keka is not added this time.`,
        );
      }

      return events;
    }

    const leaveEvents = events.filter((event) => event.type === "leave");
    const known = new Set(leaveEvents.map((event) => event.email));
    // Same person under a different email in the Time Tracker and Keka:
    // the name is a second guard so they are never announced twice.
    const knownNames = new Set(
      leaveEvents.map((event) => event.name.trim().toLowerCase()),
    );

    const [year, month, day] = today.split("-");

    const extra: TeamActivityEvent[] = people
      .filter(
        (person) =>
          !known.has(person.email) &&
          !knownNames.has(person.name.trim().toLowerCase()),
      )
      .map((person) => ({
        // Same ID as a Time Tracker leave row: never announced twice.
        id: `leave-${person.email}-${today}`,
        type: "leave" as const,
        name: person.name,
        email: person.email,
        project: "On Leave",
        previousProject: null,
        startTime: "",
        dateSubmitted: `${day}-${month}-${year}`,
        totalHours: 0,
        // Half-day leave: moon half-lit on the left (first half) / right (second half).
        icon: person.part === "first" ? "🌗" : person.part === "second" ? "🌓" : undefined,
        message:
          person.part === "first"
            ? `${person.name} is on half-day leave today (first half)`
            : person.part === "second"
              ? `${person.name} is on half-day leave today (second half)`
              : `${person.name} is on leave today`,
      }));

    if (extra.length === 0) {
      return events;
    }

    const leaves = events.filter((event) => event.type === "leave");
    const rest = events.filter((event) => event.type !== "leave");

    return [...leaves, ...extra, ...rest];
  }

  private async getTrackerActivity(): Promise<TeamActivityEvent[]> {
    const entries = await this.timeTrackerService.getTimeEntries();

    const today = this.getToday();

    // Start a completely fresh activity feed when the day changes.
    if (this.currentDay !== today) {
      this.currentDay = today;
      this.previousRows.clear();
      this.activityEvents = [];
      this.reportedInvalidRows.clear();
    }

    // Rows whose date/time can't be read are skipped (with a warning)
    // so they can never produce a false notification.
    const todayEntries = this.skipInvalidEntries(entries, today)
      .filter((entry) => this.getEntryDate(entry) === today)
      .sort(
        (a, b) =>
          this.getEntryMinutes(a.startTime) -
          this.getEntryMinutes(b.startTime),
      );

    const currentRows = new Map<string, RawTimeTrackerEntry>();

    for (const entry of todayEntries) {
      currentRows.set(this.getRowKey(entry), entry);
    }

    // First load of the day:
    // Build the activity history from entries already present today.
    if (this.previousRows.size === 0 && todayEntries.length > 0) {
      for (let index = 0; index < todayEntries.length; index++) {
        const entry = todayEntries[index];

        if (!entry) {
          continue;
        }

        const email = this.normalise(entry.email);

        const earlierEntries = todayEntries.slice(0, index);

        const previousEntry = [...earlierEntries]
          .reverse()
          .find(
            (previous) =>
              this.normalise(previous.email) === email &&
              !previous.isOnLeave,
          );

        const type: TeamActivityType = entry.isOnLeave
          ? "leave"
          : previousEntry
            ? "project_change"
            : "login";

        this.addEvent(entry, type, previousEntry);
      }

      this.previousRows = currentRows;

      return this.getEventsForToday();
    }

    // Detect new Time Tracker rows after the initial load.
    for (const [key, current] of currentRows) {
      const previous = this.previousRows.get(key);

      if (!previous) {
        const email = this.normalise(current.email);

        const earlierEntries = todayEntries
          .filter((entry) => {
            if (this.getRowKey(entry) === key) {
              return false;
            }

            return (
              this.normalise(entry.email) === email &&
              !entry.isOnLeave &&
              this.getEntryMinutes(entry.startTime) <
                this.getEntryMinutes(current.startTime)
            );
          })
          .sort(
            (a, b) =>
              this.getEntryMinutes(a.startTime) -
              this.getEntryMinutes(b.startTime),
          );

        const previousEntry =
          earlierEntries.length > 0
            ? earlierEntries[earlierEntries.length - 1]
            : undefined;

        const type: TeamActivityType = current.isOnLeave
          ? "leave"
          : previousEntry
            ? "project_change"
            : "login";

        this.addEvent(current, type, previousEntry);

        continue;
      }

      // If an existing row changes project,
      // treat it as a project change.
      if (
        !current.isOnLeave &&
        this.normalise(previous.project) !==
          this.normalise(current.project)
      ) {
        this.addEvent(current, "project_change", previous);
      }
    }

    this.previousRows = currentRows;

    return this.getEventsForToday();
  }

  // Returns only rows with a readable date and, for today's work rows,
  // a readable start time. Logs one warning per new invalid row.
  private skipInvalidEntries(
    entries: RawTimeTrackerEntry[],
    today: string,
  ): RawTimeTrackerEntry[] {
    const valid: RawTimeTrackerEntry[] = [];
    const problems: string[] = [];

    for (const entry of entries) {
      let problem: string | null = null;

      if (!entry || typeof entry !== "object") {
        // e.g. a null in the list: nothing to read a row number from.
        if (!this.reportedInvalidRows.has("not-an-object")) {
          this.reportedInvalidRows.add("not-an-object");
          problems.push("a Time Tracker entry that is not a row");
        }

        continue;
      }

      if (!this.isValidDate(entry.dateSubmitted)) {
        problem = `unreadable dateSubmitted "${entry.dateSubmitted ?? ""}"`;
      } else if (
        this.getEntryDate(entry) === today &&
        !entry.isOnLeave &&
        !this.isValidTime(entry.startTime)
      ) {
        // Leave rows have no start time, which is normal.
        problem = `unreadable startTime "${entry.startTime ?? ""}"`;
      }

      if (!problem) {
        valid.push(entry);
        continue;
      }

      const key = `${entry.rowIndex}|${entry.email}|${entry.dateSubmitted}|${entry.startTime}`;

      if (!this.reportedInvalidRows.has(key)) {
        this.reportedInvalidRows.add(key);
        problems.push(
          `row ${entry.rowIndex} (${entry.name || entry.email || "unknown"}): ${problem}`,
        );
      }
    }

    if (problems.length > 0) {
      const shown = problems.slice(0, 5).join("; ");
      const more =
        problems.length > 5
          ? ` … and ${problems.length - 5} more`
          : "";

      console.warn(
        `Team Activity: skipped ${problems.length} Time Tracker row(s) with an unreadable date/time (no notification created): ${shown}${more}`,
      );
    }

    return valid;
  }

  // "DD-MM-YYYY" and a real calendar date.
  private isValidDate(value: string): boolean {
    // Not trimmed: getEntryDate() doesn't trim either, so a padded
    // value would otherwise be silently dropped instead of reported.
    const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(
      String(value ?? ""),
    );

    if (!match) {
      return false;
    }

    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));

    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }

  // "H:MM" / "HH:MM", 00:00–23:59.
  private isValidTime(value: string): boolean {
    const match = /^(\d{1,2}):(\d{2})$/.exec(
      String(value ?? "").trim(),
    );

    return (
      !!match &&
      Number(match[1]) < 24 &&
      Number(match[2]) < 60
    );
  }

  private addEvent(
    entry: RawTimeTrackerEntry,
    type: TeamActivityType,
    previousEntry?: RawTimeTrackerEntry,
  ): void {
    const event = this.createEvent(
      entry,
      type,
      previousEntry,
    );

    const alreadyExists = this.activityEvents.some(
      (existing) => existing.id === event.id,
    );

    if (!alreadyExists) {
      this.activityEvents.push(event);
    }
  }

  private createEvent(
    entry: RawTimeTrackerEntry,
    type: TeamActivityType,
    previousEntry?: RawTimeTrackerEntry,
  ): TeamActivityEvent {
    const project = this.clean(entry.project) || "Unknown project";
    const name = this.clean(entry.name) || entry.email;
    const email = this.clean(entry.email).toLowerCase();

    const time = this.formatTime(entry.startTime);

    let previousProject: string | null = null;

    let message: string;

    if (type === "leave") {
      message = `${name} is on leave today`;
    } else if (
      type === "project_change" &&
      previousEntry
    ) {
      previousProject =
        this.clean(previousEntry.project) || "Unknown project";

      message = `${name} switched to ${project} from ${previousProject} at ${time}`;
    } else {
      const loginEmoji = this.getLoginEmoji(
        entry.startTime,
      );

      message = `${name} has started working on ${project} at ${time} ${loginEmoji}`;
    }

    return {
      // Stable, deterministic IDs built from the entry's content.
      //
      // Leave: ONE ID per employee per day (unchanged).
      //
      // Work activity: person + date + start time + project.
      // Previously this used the sheet row number (rowIndex), which
      // changes whenever a row above is inserted or deleted, so the
      // same activity could get a new ID and be sent again.
      // Start time alone is not unique (people switch projects within
      // the same minute), so the project is part of the ID.
      id:
        type === "leave"
          ? `leave-${email}-${this.getEntryDate(entry)}`
          : `activity-${email}-${this.getEntryDate(entry)}-${this.normaliseTime(entry.startTime)}-${this.normalise(project)}`,
      type,
      name,
      email,
      project,
      previousProject,
      startTime: entry.startTime,
      dateSubmitted: entry.dateSubmitted,
      totalHours: entry.totalHours,
      message,
    };
  }

  private getLoginEmoji(startTime: string): string {
    const minutes = this.getEntryMinutes(startTime);

    if (minutes < 10 * 60) {
      return "😄";
    }

    if (minutes <= 10 * 60 + 30) {
      return "🙂";
    }

    return "🙁";
  }

  private getEventsForToday(): TeamActivityEvent[] {
    return [...this.activityEvents].sort((a, b) => {
      // Always keep leave activities at the top.
      if (a.type === "leave" && b.type !== "leave") {
        return -1;
      }

      if (a.type !== "leave" && b.type === "leave") {
        return 1;
      }

      // Keep normal activities chronological.
      return (
        this.getEntryMinutes(a.startTime) -
        this.getEntryMinutes(b.startTime)
      );
    });
  }

  // Identifies the same Time Tracker row between polls.
  //
  // rowIndex is the Google Sheet row number. It shifts when any row
  // above is inserted or deleted, so row N can hold a DIFFERENT
  // person's entry on the next poll. Matching by rowIndex produced
  // messages mixing two people (e.g. "Jonish switched to KFH New
  // from RVVPL", where RVVPL was Ashwani's project) and re-sent
  // entries whose row number had changed. Match by content instead.
  private getRowKey(entry: RawTimeTrackerEntry): string {
    return [
      entry.email,
      entry.dateSubmitted,
      this.normaliseTime(entry.startTime),
      entry.project,
    ]
      .map((value) => this.normalise(String(value ?? "")))
      .join("|");
  }

  // "9:47" and "09:47" → "09:47".
  private normaliseTime(value: string): string {
    const minutes = this.getEntryMinutes(value);

    if (minutes === Number.MAX_SAFE_INTEGER) {
      return this.normalise(String(value ?? ""));
    }

    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }

  private getEntryDate(entry: RawTimeTrackerEntry): string {
    if (!entry.dateSubmitted) {
      return "";
    }

    const parts = entry.dateSubmitted.split("-");

    if (parts.length !== 3) {
      return "";
    }

    const day = parts[0];
    const month = parts[1];
    const year = parts[2];

    if (!day || !month || !year) {
      return "";
    }

    return `${year}-${month}-${day}`;
  }

  private getToday(): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .reduce<Record<string, string>>((result, part) => {
        if (part.type !== "literal") {
          result[part.type] = part.value;
        }

        return result;
      }, {});

    const year = parts.year ?? "";
    const month = parts.month ?? "";
    const day = parts.day ?? "";

    return `${year}-${month}-${day}`;
  }

  private getEntryMinutes(value: string): number {
    if (!value || typeof value !== "string") {
      return Number.MAX_SAFE_INTEGER;
    }

    const parts = value.split(":");

    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);

    if (
      Number.isNaN(hours) ||
      Number.isNaN(minutes)
    ) {
      return Number.MAX_SAFE_INTEGER;
    }

    return hours * 60 + minutes;
  }

  private formatTime(value: string): string {
    const minutes = this.getEntryMinutes(value);

    if (minutes === Number.MAX_SAFE_INTEGER) {
      return value;
    }

    const hours24 = Math.floor(minutes / 60);
    const mins = minutes % 60;

    const period = hours24 >= 12 ? "PM" : "AM";
    const hours12 = hours24 % 12 || 12;

    return `${hours12}:${String(mins).padStart(2, "0")} ${period}`;
  }

  // Cells can arrive as null/undefined/numbers; never throw on them.
  private clean(value: unknown): string {
    return String(value ?? "").trim();
  }

  private normalise(value: unknown): string {
    return this.clean(value).toLowerCase();
  }
}