import {
  KekaClient,
  type KekaEmployee,
  type KekaLeaveRequest,
} from "../integrations/keka/keka.client.js";
import { leaveEmailsForHalf, leaveEmailsOn } from "./kekaLeave.service.js";
import { TimeTrackerClient } from "../integrations/timeTracker/timeTracker.client.js";
import type { RawTimeTrackerEntry } from "../integrations/timeTracker/timeTracker.types.js";
import {
  formatTimeLabel,
  readMissingTimesheetConfig,
} from "../config/missingTimesheetConfig.js";

// ---------------------------------------------------------------
// Missing Timesheet: who has not logged in the Time Tracker today.
//
// The Time Tracker is the source of who logged. The only other thing read is
// Keka LEAVE (read-only), so people on leave are never listed.
//
//   people     = everyone with a WORK row in the Time Tracker in the last
//                30 days before today (leave rows alone do not count), minus
//                the approved always-excluded emails
//   has logged = any Time Tracker row dated today for that email: a started
//                timer, a finished entry, or a leave row (leave is a
//                reason to have no timesheet, so it is not "missing")
//   MISSING    = a person who has not logged today
//
// Two safety rules keep a bad answer from becoming a noisy message:
//   - if the Time Tracker cannot be read, or returns no usable rows,
//     buildReport() THROWS: no message, nothing guessed;
//   - if there is NOT A SINGLE row dated today (a holiday, or the Time
//     Tracker is not updating), no list is built and nothing is sent.
//
// When nobody is missing, no message is produced at all.
// ---------------------------------------------------------------

// How far back someone must have logged work to be expected to log today.
export const ACTIVE_WINDOW_DAYS = 30;

export interface MissingPerson {
  name: string;
  email: string;
}

export interface MissingTimesheetResult {
  // India date, "YYYY-MM-DD".
  today: string;
  // Sorted by name.
  missing: MissingPerson[];
  // True when no row at all is dated today: not a usable day.
  noDataToday: boolean;
  counts: {
    rows: number;
    // Rows ignored because the email or date could not be read.
    ignoredRows: number;
    rowsToday: number;
    people: number;
    onLeaveToday: number;
    excluded: number;
    missing: number;
  };
}

// Thrown when the Time Tracker data cannot be used. The message is safe to
// log (never contains a URL or key).
export class MissingTimesheetDataError extends Error {}

const normEmail = (value: unknown) => String(value ?? "").trim().toLowerCase();

// Time Tracker date "DD-MM-YYYY" → "YYYY-MM-DD", or null when unreadable.
export function trackerDateKey(value: unknown): string | null {
  const match = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(value ?? "").trim());

  if (!match) {
    return null;
  }

  const [, d, m, y] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));

  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(m) - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    return null;
  }

  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));

  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
}

export function findMissingTimesheets(input: {
  rows: RawTimeTrackerEntry[];
  // India date, "YYYY-MM-DD".
  today: string;
  // Emails that are never listed (approved leadership), any case.
  excludedEmails?: Iterable<string>;
  // Emails on leave today according to Keka (approved or pending). They are
  // never listed, even when the Time Tracker has no leave row for them.
  leaveEmails?: Iterable<string>;
}): MissingTimesheetResult {
  const excluded = new Set(
    [...(input.excludedEmails ?? [])].map((email) => normEmail(email)),
  );

  const kekaLeave = new Set(
    [...(input.leaveEmails ?? [])].map((email) => normEmail(email)),
  );

  const earliest = addDays(input.today, -ACTIVE_WINDOW_DAYS);

  // Latest name seen for each email (rows are in the tracker's own order;
  // the most recent date wins).
  const names = new Map<string, { name: string; date: string }>();
  const workedRecently = new Set<string>();
  const loggedToday = new Set<string>();
  const onLeaveToday = new Set<string>();

  let ignored = 0;
  let rowsToday = 0;

  for (const row of input.rows) {
    const email = normEmail(row?.email);
    const date = trackerDateKey(row?.dateSubmitted);

    if (!row || typeof row !== "object" || !email || !date) {
      ignored++;
      continue;
    }

    const name = String(row.name ?? "").trim();

    if (name && (names.get(email)?.date ?? "") <= date) {
      names.set(email, { name, date });
    }

    if (date === input.today) {
      rowsToday++;
      loggedToday.add(email);

      if (row.isOnLeave) {
        onLeaveToday.add(email);
      }
    } else if (!row.isOnLeave && date >= earliest && date < input.today) {
      workedRecently.add(email);
    }
  }

  if (input.rows.length === 0 || ignored === input.rows.length) {
    throw new MissingTimesheetDataError(
      "The Time Tracker returned no usable rows, so missing timesheets cannot be determined",
    );
  }

  const noDataToday = rowsToday === 0;

  for (const email of kekaLeave) {
    loggedToday.add(email);
    onLeaveToday.add(email);
  }

  let excludedCount = 0;
  const missing: MissingPerson[] = [];

  for (const email of workedRecently) {
    if (excluded.has(email)) {
      excludedCount++;
      continue;
    }

    if (!noDataToday && !loggedToday.has(email)) {
      missing.push({ email, name: names.get(email)?.name || email });
    }
  }

  missing.sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  );

  return {
    today: input.today,
    missing,
    noDataToday,
    counts: {
      rows: input.rows.length,
      ignoredRows: ignored,
      rowsToday,
      people: workedRecently.size - excludedCount,
      onLeaveToday: onLeaveToday.size,
      excluded: excludedCount,
      missing: missing.length,
    },
  };
}

// ---------------------------------------------------------------
// Message
// ---------------------------------------------------------------

const TZ = "Asia/Kolkata";

// "YYYY-MM-DD" in India time.
// Which half of the working day a check falls in: 0 = first half (before
// 2:00 PM India time), 1 = second half. Half-day leave only excuses the half
// it covers, so a first-half leave is not listed at 12:00 PM but is listed at
// 3:00 PM if still nothing is logged (and the other way round).
export function currentHalf(at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );

  return Number(parts.hour) * 60 + Number(parts.minute) < 14 * 60 ? 0 : 1;
}

export function indiaDate(at: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Fixed three-letter month names, so the message reads the same on every
// machine (Intl's short month differs between Node/ICU versions).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "14 Oct 2026"
export function formatIndiaDate(at: Date): string {
  const [y, m, d] = indiaDate(at).split("-").map(Number);

  return `${d} ${MONTHS[m! - 1]} ${y}`;
}

// "11:49 AM" for an instant, in India time (manual runs use this).
export function currentTimeLabel(at: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );

  return formatTimeLabel(Number(parts.hour), Number(parts.minute));
}

// Google Chat text messages are limited to about 4,000 characters. A
// list that long is an error, never silently cut off.
export const MAX_MESSAGE_CHARS = 4_000;

export function missingTimesheetHeader(timeLabel: string): string {
  return `🟡 Missing Timesheet — ${timeLabel} IST`;
}

//   🟡 Missing Timesheet — 12:00 PM IST
//   Date: 14 Oct 2026
//
//   🟡 Name
//   🟡 Name
//
//   Total missing timesheets: 2
//
// Only built when at least one person is missing.
export function buildMissingTimesheetMessage(input: {
  names: string[];
  // The instant of the report (only its India date is shown).
  at: Date;
  // The scheduled time shown in the header, e.g. "12:00 PM".
  timeLabel: string;
}): string {
  if (input.names.length === 0) {
    throw new MissingTimesheetDataError(
      "There is no missing timesheet, so there is no message to build",
    );
  }

  const message = [
    missingTimesheetHeader(input.timeLabel),
    `Date: ${formatIndiaDate(input.at)}`,
    "",
    ...input.names.map((name) => `🟡 ${name}`),
    "",
    `Total missing timesheets: ${input.names.length}`,
  ].join("\n");

  if (message.length > MAX_MESSAGE_CHARS) {
    throw new MissingTimesheetDataError(
      `The list is too long for one Google Chat message (${message.length} characters)`,
    );
  }

  return message;
}

// ---------------------------------------------------------------
// Reporter: read the Time Tracker → find who is missing → message
// ---------------------------------------------------------------

export interface RowSource {
  getData(): Promise<RawTimeTrackerEntry[]>;
}

// ---------------------------------------------------------------
// Leave from Keka (read-only). The Time Tracker only gets a leave row once a
// request is synced, and pending requests are not, so Keka is asked directly.
// A person is on leave on a day when BOTH halves of that day are covered by
// a pending or approved request (a lone half-day leave still has to log).
// ---------------------------------------------------------------

export { leaveEmailsOn };

export interface LeaveSource {
  // Emails (lower case) on leave on `date` ("YYYY-MM-DD"). THROWS when
  // Keka cannot be read completely.
  // `half`: 0 = first half of the day, 1 = second half.
  getLeaveEmails(date: string, half: number): Promise<Set<string>>;
}

export function createKekaLeaveSource(client: {
  getActiveEmployees(): Promise<KekaEmployee[]>;
  getLeaveRequests(from: string, to: string): Promise<KekaLeaveRequest[]>;
}): LeaveSource {
  return {
    async getLeaveEmails(date, half) {
      const [employees, requests] = await Promise.all([
        client.getActiveEmployees(),
        client.getLeaveRequests(date, date),
      ]);

      return leaveEmailsForHalf(date, half, requests, employees);
    },
  };
}

export interface MissingTimesheetReport {
  // null when there is nothing to send.
  message: string | null;
  // Why there is no message ("" when there is one).
  reason: "" | "nobody_missing" | "no_data_today";
  names: string[];
  result: MissingTimesheetResult;
  retrievedAt: Date;
}

export class MissingTimesheetReporter {
  private readonly now: () => Date;

  constructor(
    private readonly source: RowSource,
    now?: () => Date,
    private readonly excludedEmails: string[] = [],
    // Optional: when set, people on leave in Keka are left out too.
    private readonly leaveSource?: LeaveSource,
  ) {
    this.now = now ?? (() => new Date());
  }

  // THROWS when the Time Tracker cannot be read or returns nothing usable.
  // Returns message = null when there is nothing to send (nobody missing,
  // or no data for today at all).
  // `timeLabel` is the scheduled time for the header ("12:00 PM"); a manual
  // run omits it and gets the actual current India time.
  async buildReport(options: { timeLabel?: string } = {}): Promise<MissingTimesheetReport> {
    const rows = await this.source.getData();

    const retrievedAt = this.now();

    const today = indiaDate(retrievedAt);

    // If Keka is configured but cannot be read this THROWS: no message,
    // nothing guessed (the watcher retries within the slot's window).
    const leaveEmails = this.leaveSource
      ? await this.leaveSource.getLeaveEmails(today, currentHalf(retrievedAt))
      : undefined;

    const result = findMissingTimesheets({
      rows,
      today,
      excludedEmails: this.excludedEmails,
      leaveEmails,
    });

    const names = result.missing.map((person) => person.name);

    if (result.noDataToday) {
      return { message: null, reason: "no_data_today", names, result, retrievedAt };
    }

    if (names.length === 0) {
      return { message: null, reason: "nobody_missing", names, result, retrievedAt };
    }

    return {
      message: buildMissingTimesheetMessage({
        names,
        at: retrievedAt,
        timeLabel: options.timeLabel ?? currentTimeLabel(retrievedAt),
      }),
      reason: "",
      names,
      result,
      retrievedAt,
    };
  }
}

export function createMissingTimesheetReporterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MissingTimesheetReporter {
  // Keka leave is used only when every Keka setting is present; otherwise
  // the report works from the Time Tracker alone, as before.
  const kekaConfigured = [
    "KEKA_BASE_URL",
    "KEKA_CLIENT_ID",
    "KEKA_CLIENT_SECRET",
    "KEKA_API_KEY",
  ].every((name) => (env[name] ?? "").trim() !== "");

  return new MissingTimesheetReporter(
    new TimeTrackerClient(),
    undefined,
    readMissingTimesheetConfig(env).excludedEmails,
    kekaConfigured ? createKekaLeaveSource(new KekaClient({ env })) : undefined,
  );
}
