import fs from "node:fs";
import path from "node:path";

import {
  MISSING_TIMESHEET_TIME_ZONE,
  MISSING_TIMESHEET_WINDOW_MINUTES,
  readMissingTimesheetConfig,
  describeMissingTimesheetConfig,
  type SendTime,
} from "../config/missingTimesheetConfig.js";
import { resolveStatePath } from "../config/runtimeConfig.js";
import { googleChatService } from "../integrations/googleChat/googleChat.service.js";
import {
  createMissingTimesheetReporterFromEnv,
  type MissingTimesheetReport,
} from "./missingTimesheet.service.js";
import { LogThrottle } from "./logThrottle.js";

// ---------------------------------------------------------------
// Missing Timesheet schedule.
//
// Monday–Friday, at each time in MISSING_TIMESHEET_SEND_TIMES (default
// 12:00 and 15:00 India Standard Time, Asia/Kolkata, whatever the server's
// own time zone is), one check per time slot.
//
//   - A message is posted ONLY when somebody is missing. If nobody is
//     missing (or the Time Tracker has no row at all for today), that
//     slot is finished and nothing is posted.
//   - Polls every 10 seconds, so a check happens within ~10 s of its time.
//   - Every slot is independent. If the Time Tracker or Google Chat
//     fails, that slot retries every minute for 30 minutes. If it still
//     could not be done, the failure is logged; NOTHING is posted to the
//     Space about it, and no stale list is sent later.
//   - Each (date, time slot) that was handled is saved (in memory first,
//     then in the state file), so repeated checks and restarts never send
//     the same message twice.
//   - Saturday and Sunday never run.
//
// It is started once, by server.ts, and only when
// MISSING_TIMESHEET_SCHEDULE_ENABLED=true AND a safe destination is
// configured. Requires the service to be running at those times.
// ---------------------------------------------------------------

const RETRY_DELAY_MS = 60_000;
const DEFAULT_POLL_MS = 10_000;
// Days of history kept in the state file.
const KEEP_DAYS = 7;

interface DayState {
  // Slot keys ("12:00") for which a message was sent that day.
  sent: string[];
  // Slot keys that were checked and had nothing to send.
  nothingToSend: string[];
}

interface State {
  days: Record<string, DayState>;
}

interface SlotFailures {
  count: number;
  nextAttemptAt: number;
  lastError: string;
  reported: boolean;
}

export interface MissingTimesheetWatcherOptions {
  reporter: {
    buildReport(options?: { timeLabel?: string }): Promise<MissingTimesheetReport>;
  };
  // Posts text to the chosen Space (already bound to its webhook).
  send: (message: string) => Promise<void>;
  // India times of the daily checks (from MISSING_TIMESHEET_SEND_TIMES).
  slots: SendTime[];
  now?: () => Date;
  stateFile?: string;
}

export interface IndiaClock {
  date: string;
  hour: number;
  minute: number;
  // 0 = Sunday … 6 = Saturday
  dayOfWeek: number;
}

const WEEKDAY_NUMBER: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// Wall clock in India for an instant. The time zone is named explicitly,
// so the result never depends on the server's own time zone.
export function indiaClock(at: Date): IndiaClock {
  const values: Record<string, string> = {};

  for (const part of new Intl.DateTimeFormat("en-GB", {
    timeZone: MISSING_TIMESHEET_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(at)) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour ?? 0),
    minute: Number(values.minute ?? 0),
    dayOfWeek: WEEKDAY_NUMBER[values.weekday ?? ""] ?? -1,
  };
}

// Monday–Friday.
export function isScheduledDay(dayOfWeek: number): boolean {
  return dayOfWeek >= 1 && dayOfWeek <= 5;
}

export class MissingTimesheetWatcher {
  private readonly stateFile: string;
  private readonly now: () => Date;
  private readonly logs: LogThrottle;
  private readonly slots: SendTime[];

  private interval: NodeJS.Timeout | null = null;
  private isChecking = false;
  private state: State = { days: {} };

  // Failures of today's slots, in memory only ("2026-10-14|12:00").
  private failures = new Map<string, SlotFailures>();

  constructor(private readonly options: MissingTimesheetWatcherOptions) {
    this.slots = [...options.slots].sort(
      (a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute),
    );
    this.now = options.now ?? (() => new Date());
    this.stateFile =
      options.stateFile ?? resolveStatePath(".missing-timesheet-state.json");
    this.logs = new LogThrottle(5 * 60_000, () => this.now().getTime());

    this.loadState();
  }

  // Registers the schedule. Calling it again does nothing.
  start(intervalMs = DEFAULT_POLL_MS): void {
    if (this.interval) {
      return;
    }

    console.log(
      `Missing Timesheet watcher started (weekdays ${this.slots.map((s) => s.label).join(", ")} ${MISSING_TIMESHEET_TIME_ZONE}; posts only when someone is missing).`,
    );

    void this.check();

    this.interval = setInterval(() => {
      void this.check();
    }, intervalMs);
  }

  stop(): void {
    if (!this.interval) {
      return;
    }

    clearInterval(this.interval);
    this.interval = null;

    console.log("Missing Timesheet watcher stopped.");
  }

  getStatus(): {
    scheduled: boolean;
    times: string[];
    sentToday: string[];
    nothingToSendToday: string[];
    failedAttemptsToday: number;
    lastError: string | null;
  } {
    const date = indiaClock(this.now()).date;

    let failed = 0;
    let lastError = "";

    for (const [key, value] of this.failures) {
      if (key.startsWith(`${date}|`)) {
        failed += value.count;
        lastError = value.lastError || lastError;
      }
    }

    const day = this.state.days[date];

    return {
      scheduled: this.interval !== null,
      times: this.slots.map((slot) => slot.label),
      sentToday: this.slots
        .filter((slot) => day?.sent.includes(slot.key))
        .map((slot) => slot.label),
      nothingToSendToday: this.slots
        .filter((slot) => day?.nothingToSend.includes(slot.key))
        .map((slot) => slot.label),
      failedAttemptsToday: failed,
      lastError: lastError || null,
    };
  }

  async check(): Promise<void> {
    if (this.isChecking) {
      return;
    }

    this.isChecking = true;

    try {
      const clock = indiaClock(this.now());

      // Only today's failures matter.
      for (const key of [...this.failures.keys()]) {
        if (!key.startsWith(`${clock.date}|`)) {
          this.failures.delete(key);
        }
      }

      if (!isScheduledDay(clock.dayOfWeek)) {
        return;
      }

      const minutes = clock.hour * 60 + clock.minute;

      for (const slot of this.slots) {
        if (this.isDone(clock.date, slot.key)) {
          continue;
        }

        const start = slot.hour * 60 + slot.minute;
        const end = start + MISSING_TIMESHEET_WINDOW_MINUTES;

        // Slots are in time order: nothing later is due yet either.
        if (minutes < start) {
          break;
        }

        if (minutes >= end) {
          this.reportMissedSlot(clock.date, slot);
          continue;
        }

        const failure = this.failures.get(`${clock.date}|${slot.key}`);

        if (failure && this.now().getTime() < failure.nextAttemptAt) {
          continue;
        }

        await this.attempt(clock.date, slot);
      }
    } catch (error) {
      this.logs.failure(
        "missing-timesheet-watcher",
        "Missing Timesheet watcher error:",
        error,
      );
    } finally {
      this.isChecking = false;
    }
  }

  private async attempt(date: string, slot: SendTime): Promise<void> {
    let report: MissingTimesheetReport;

    try {
      report = await this.options.reporter.buildReport({
        timeLabel: slot.label,
      });

      this.logs.success(
        "missing-timesheet-tracker",
        "Missing Timesheet: Time Tracker read succeeded",
      );
    } catch (error) {
      // Time Tracker unavailable or unusable: nothing is sent.
      this.recordFailure(date, slot, "Time Tracker read", error);
      return;
    }

    const c = report.result.counts;

    // Counts only: names are not written to the log.
    console.log(
      `Missing Timesheet ${date} ${slot.label}: ${c.people} people expected, ${c.rowsToday} rows today, ${c.onLeaveToday} on leave, ${c.excluded} excluded, ${c.missing} missing.`,
    );

    if (report.message === null) {
      // Nothing to send: this slot is finished and no message is posted.
      this.day(date).nothingToSend.push(slot.key);

      this.saveState();

      this.failures.delete(`${date}|${slot.key}`);

      console.log(
        report.reason === "no_data_today"
          ? `Missing Timesheet ${date} ${slot.label}: the Time Tracker has no row for today (holiday or not updating), so no message is sent.`
          : `Missing Timesheet ${date} ${slot.label}: nobody is missing, so no message is sent.`,
      );

      return;
    }

    try {
      await this.options.send(report.message);
    } catch (error) {
      this.recordFailure(date, slot, "Google Chat delivery", error);
      return;
    }

    // Remember in memory FIRST so this process can never send this slot
    // twice today, even if saving the file fails.
    this.day(date).sent.push(slot.key);

    this.saveState();

    this.failures.delete(`${date}|${slot.key}`);

    this.logs.success(
      "missing-timesheet-chat",
      "Missing Timesheet: Google Chat delivery succeeded",
    );

    console.log(`Missing Timesheet message sent for ${date} ${slot.label}.`);
  }

  private recordFailure(
    date: string,
    slot: SendTime,
    stage: string,
    error: unknown,
  ): void {
    const key = `${date}|${slot.key}`;
    const previous = this.failures.get(key);

    this.failures.set(key, {
      count: (previous?.count ?? 0) + 1,
      nextAttemptAt: this.now().getTime() + RETRY_DELAY_MS,
      lastError: `${stage}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
      reported: previous?.reported ?? false,
    });

    this.logs.failure(
      `missing-timesheet-${slot.key}`,
      `Missing Timesheet ${date} ${slot.label}: ${stage} failed; no message sent; retrying every ${RETRY_DELAY_MS / 1000}s for ${MISSING_TIMESHEET_WINDOW_MINUTES} minutes.`,
      error,
    );
  }

  // After a slot's window: if every attempt failed, say so once in the log.
  // Nothing is posted to the Space and no stale list is sent later.
  private reportMissedSlot(date: string, slot: SendTime): void {
    const failure = this.failures.get(`${date}|${slot.key}`);

    if (!failure || failure.reported) {
      return;
    }

    failure.reported = true;

    console.error(
      `Missing Timesheet was NOT checked for ${date} ${slot.label}: all ${failure.count} attempts failed (${failure.lastError}). Nothing was posted.`,
    );
  }

  private day(date: string): DayState {
    let day = this.state.days[date];

    if (!day) {
      day = { sent: [], nothingToSend: [] };
      this.state.days[date] = day;
    }

    return day;
  }

  private isDone(date: string, slotKey: string): boolean {
    const day = this.state.days[date];

    return !!day && (day.sent.includes(slotKey) || day.nothingToSend.includes(slotKey));
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.stateFile)) {
        return;
      }

      const data = JSON.parse(
        fs.readFileSync(this.stateFile, "utf-8"),
      ) as { days?: Record<string, Partial<DayState>> };

      const strings = (value: unknown) =>
        Array.isArray(value)
          ? value.filter((v): v is string => typeof v === "string")
          : [];

      for (const [date, day] of Object.entries(data.days ?? {})) {
        this.state.days[date] = {
          sent: strings(day.sent),
          nothingToSend: strings(day.nothingToSend),
        };
      }
    } catch (error) {
      console.error("Failed to load Missing Timesheet state:", error);
    }
  }

  private saveState(): void {
    try {
      // Keep only the most recent days.
      const keep = Object.keys(this.state.days).sort().slice(-KEEP_DAYS);

      this.state.days = Object.fromEntries(
        keep.map((date) => [date, this.state.days[date]!]),
      );

      // Temp file then rename, so a crash mid-write cannot leave a
      // broken file (which could allow a second message).
      const tempFile = `${this.stateFile}.tmp`;

      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(tempFile, JSON.stringify(this.state, null, 2), "utf-8");
      fs.renameSync(tempFile, this.stateFile);
    } catch (error) {
      console.error(
        `Failed to save Missing Timesheet state to ${this.stateFile}. The slot was handled; it will not be repeated while the service keeps running, but could be sent again if the service restarts within its 30-minute window.`,
        error,
      );
    }
  }
}

// Builds the watcher from the environment, or returns null (with the
// reason logged, never any secret) when the schedule is off or there is
// no safe destination. The main Space is used only when
// MISSING_TIMESHEET_POST_TO_MAIN_SPACE=true.
export function createMissingTimesheetWatcherFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MissingTimesheetWatcher | null {
  console.log(describeMissingTimesheetConfig(env));

  const config = readMissingTimesheetConfig(env);

  for (const warning of config.warnings) {
    console.warn(`Missing Timesheet: ${warning}`);
  }

  if (!config.scheduleEnabled || !config.destination) {
    return null;
  }

  const { webhookUrl } = config.destination;

  try {
    return new MissingTimesheetWatcher({
      reporter: createMissingTimesheetReporterFromEnv(env),
      slots: config.sendTimes,
      send: (message) =>
        googleChatService.sendMissingTimesheetMessage(webhookUrl, message),
    });
  } catch (error) {
    // e.g. TIME_TRACKER_API_URL missing: report it and leave the schedule
    // off. The rest of the service is unaffected.
    console.error(
      `Missing Timesheet: schedule NOT started: ${error instanceof Error ? error.message : String(error)}.`,
    );

    return null;
  }
}
