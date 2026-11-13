import fs from "node:fs";
import path from "node:path";

import { getTeamActivityStateDir } from "../config/runtimeConfig.js";

// ---------------------------------------------------------------
// Persistent delivery state for Team Activity → Google Chat.
//
// The same three files are used every day (no dated files):
//
//   <TEAM_ACTIVITY_STATE_DIR>/activity-state.json   ← the record the service uses
//   <TEAM_ACTIVITY_STATE_DIR>/sent-entries.csv      ← readable: posted
//   <TEAM_ACTIVITY_STATE_DIR>/skipped-entries.csv   ← readable: not posted yet / not posted
//
// activity-state.json holds today's activities (and, only while they
// are still waiting to be sent, earlier days' ones). After midnight
// (IST) the previous day's entries are removed, so the files start
// fresh each day. Writes are atomic (temp file + fsync + rename) so a
// crash mid-write can never leave a half-written, unreadable file.
// ---------------------------------------------------------------

export type DeliveryStatus =
  // Detected, not yet confirmed delivered. Will be (re)sent.
  | "pending"
  // Google Chat confirmed delivery. Never sent again.
  | "sent"
  // Recorded but intentionally not posted (first ever run, or the
  // state file was unreadable).
  | "skipped";

export interface TeamActivityRecord {
  activityId: string;
  type: string;
  employee: string;
  email: string;
  fromProject: string | null;
  toProject: string;
  // Time shown in the message, e.g. "10:54 AM".
  timestamp: string;
  // Exact text sent to Google Chat, kept so a pending record can
  // be delivered after a restart even if Time Tracker changed.
  message: string;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  // ISO time before which the record should not be retried.
  nextAttemptAt: string | null;
  // Set just before a send starts and cleared once the outcome is
  // known. If still set after a restart, the process died while the
  // message was in flight.
  sendStartedAt: string | null;
  detectedAt: string;
  sentAt: string | null;
}

// One day's records (in memory). On disk all days live in one file.
export interface DailyTeamActivityState {
  version: 1;
  date: string;
  records: TeamActivityRecord[];
}

export interface LoadResult {
  state: DailyTeamActivityState;
  // True if the file already had this day and was readable.
  existed: boolean;
  // True if the file existed but could not be read (it was moved
  // aside to activity-state.json.corrupt-<timestamp>).
  corrupt: boolean;
}

interface StateFile {
  version: 2;
  // date (YYYY-MM-DD) → that day's records
  days: Record<string, TeamActivityRecord[]>;
}

export const STATE_FILE_NAME = "activity-state.json";
export const SENT_CSV_NAME = "sent-entries.csv";
export const SKIPPED_CSV_NAME = "skipped-entries.csv";

// Files written by earlier versions (one set per day). Merged into
// activity-state.json once, then removed.
const LEGACY_DAY_JSON = /^(\d{4}-\d{2}-\d{2})\.json$/;
const LEGACY_DAY_CSV = /^\d{4}-\d{2}-\d{2}-(sent|not-sent)\.csv$/;

// How long quarantined corrupt files and stray temp files are kept.
const JUNK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// <STATE_DIR>/team-activity-state (or TEAM_ACTIVITY_STATE_DIR).
export function resolveTeamActivityStateDir(): string {
  return getTeamActivityStateDir();
}

export class TeamActivityStateStore {
  private readonly file: string;

  // Set when the file was found unreadable, so the next load reports
  // corrupt = true once.
  private corruptDetected = false;

  constructor(
    private readonly dir: string = resolveTeamActivityStateDir(),
  ) {
    this.file = path.join(dir, STATE_FILE_NAME);
  }

  get directory(): string {
    return this.dir;
  }

  // -------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------

  // Reads activity-state.json. A READ error (permissions, I/O) is
  // thrown: the file may be fine, so it must not be treated as
  // corrupt. Unparseable content is moved aside and an empty state is
  // returned.
  private readFile(): { data: StateFile; existed: boolean } {
    this.migrateLegacyFiles();

    if (!fs.existsSync(this.file)) {
      return { data: { version: 2, days: {} }, existed: false };
    }

    const raw = fs.readFileSync(this.file, "utf-8");

    try {
      const parsed = JSON.parse(raw) as Partial<StateFile>;

      if (
        !parsed ||
        typeof parsed.days !== "object" ||
        parsed.days === null ||
        Array.isArray(parsed.days)
      ) {
        throw new Error("unexpected state file shape");
      }

      const days: Record<string, TeamActivityRecord[]> = {};

      for (const [date, records] of Object.entries(parsed.days)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Array.isArray(records)) {
          days[date] = records.filter(isValidRecord);
        }
      }

      return { data: { version: 2, days }, existed: true };
    } catch (error) {
      const quarantined = `${this.file}.corrupt-${Date.now()}`;

      try {
        fs.renameSync(this.file, quarantined);
      } catch {
        // Ignore: we still return an empty state below.
      }

      this.corruptDetected = true;

      console.error(
        `Team Activity state file ${this.file} was unreadable and was moved to ${quarantined}:`,
        error,
      );

      return { data: { version: 2, days: {} }, existed: false };
    }
  }

  load(date: string): LoadResult {
    const { data } = this.readFile();
    const records = data.days[date];

    if (records) {
      return {
        state: { version: 1, date, records },
        existed: true,
        corrupt: false,
      };
    }

    const corrupt = this.corruptDetected;
    this.corruptDetected = false;

    return {
      state: { version: 1, date, records: [] },
      existed: false,
      corrupt,
    };
  }

  // Dates that have entries in the file, oldest first.
  listDates(): string[] {
    if (!fs.existsSync(this.file) && !this.hasLegacyFiles()) {
      return [];
    }

    return Object.keys(this.readFile().data.days).sort();
  }

  // -------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------

  // Stores one day's records in activity-state.json (other days kept).
  save(state: DailyTeamActivityState): void {
    const { data } = this.readFile();

    data.days[state.date] = state.records;

    this.writeFile(data);
  }

  // Removes one day from the file (and so from the CSVs).
  delete(date: string): void {
    if (!fs.existsSync(this.file) && !this.hasLegacyFiles()) {
      return;
    }

    const { data, existed } = this.readFile();

    if (!existed || !(date in data.days)) {
      return;
    }

    delete data.days[date];

    this.writeFile(data);
  }

  // Removes days BEFORE `today` that have no pending records, so the
  // files start fresh each day. Days that still have pending records
  // are kept (and returned) so they can still be delivered.
  cleanup(today: string): {
    deleted: string[];
    retained: string[];
  } {
    const deleted: string[] = [];
    const retained: string[] = [];

    if (fs.existsSync(this.file) || this.hasLegacyFiles()) {
      const { data, existed } = this.readFile();

      if (existed) {
        for (const [date, records] of Object.entries(data.days)) {
          if (date >= today) {
            continue;
          }

          if (records.some((r) => r.status === "pending")) {
            retained.push(date);
          } else {
            delete data.days[date];
            deleted.push(date);
          }
        }

        if (deleted.length > 0) {
          this.writeFile(data);
        }
      }
    }

    this.removeOldJunk();

    return { deleted: deleted.sort(), retained: retained.sort() };
  }

  // Atomic write: temp file → fsync → rename over the real file.
  private writeFile(data: StateFile): void {
    fs.mkdirSync(this.dir, { recursive: true });

    const temp = `${this.file}.${process.pid}.tmp`;
    const json = JSON.stringify(data, null, 2);

    const fd = fs.openSync(temp, "w");

    try {
      fs.writeFileSync(fd, json, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    // On Windows, rename can briefly fail with EPERM/EBUSY if an
    // antivirus or indexer has the file open. Retry a few times.
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(temp, this.file);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;

        if (
          attempt >= 5 ||
          (code !== "EPERM" &&
            code !== "EBUSY" &&
            code !== "EACCES")
        ) {
          throw error;
        }

        // Brief synchronous wait before retrying.
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          50 * attempt,
        );
      }
    }

    // Persist the rename itself (not supported on Windows).
    try {
      const dirFd = fs.openSync(this.dir, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // best effort
    }

    // Readable copies for people. Never allowed to break saving or
    // sending (e.g. Excel locks a CSV while it is open on Windows —
    // it is then simply updated on a later save).
    this.writeCsvFiles(data);
  }

  // ---------------------------------------------------------------
  // Readable "sheets" (CSV, open in Excel / Google Sheets):
  //
  //   sent-entries.csv      everything posted to Google Chat
  //   skipped-entries.csv   waiting to be (re)sent, or not posted
  //
  // Rebuilt from activity-state.json on every save, so they always
  // match it and start fresh after midnight together with it.
  // ---------------------------------------------------------------

  private readonly csvWarnings = new Set<string>();

  // Also called on start-up so the CSVs exist even before anything
  // new happens (e.g. right after upgrading). The CSVs always cover
  // the whole file; the parameter is only kept for compatibility.
  writeReadableCopies(_state?: DailyTeamActivityState): void {
    if (!fs.existsSync(this.file)) {
      return;
    }

    try {
      this.writeCsvFiles(this.readFile().data);
    } catch {
      // Never let the readable copies affect the service.
    }
  }

  private writeCsvFiles(data: StateFile): void {
    const rows = Object.entries(data.days)
      .flatMap(([date, records]) => records.map((r) => ({ date, r })))
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          minutesOf(a.r.timestamp) - minutesOf(b.r.timestamp),
      );

    const sentCsv = toCsv(
      ["Date", "Time", "Employee", "Activity", "From project", "To project", "Message", "Sent at (IST)"],
      rows
        .filter(({ r }) => r.status === "sent")
        .map(({ date, r }) => [
          displayDate(date),
          r.timestamp,
          r.employee,
          activityLabel(r.type),
          r.fromProject ?? "",
          r.toProject,
          r.message,
          istDateTime(r.sentAt),
        ]),
    );

    const skippedCsv = toCsv(
      ["Date", "Time", "Employee", "Activity", "From project", "To project", "Message", "Status", "Reason", "Attempts", "Next try (IST)"],
      rows
        .filter(({ r }) => r.status !== "sent")
        .map(({ date, r }) => [
          displayDate(date),
          r.timestamp,
          r.employee,
          activityLabel(r.type),
          r.fromProject ?? "",
          r.toProject,
          r.message,
          r.status === "pending" ? "Waiting to be sent" : "Not posted",
          r.status === "pending"
            ? r.lastError
              ? `Last attempt failed: ${r.lastError}`
              : "Queued"
            : "Already existed when the service first started",
          String(r.attempts),
          istDateTime(r.nextAttemptAt),
        ]),
    );

    for (const [name, csv] of [
      [SENT_CSV_NAME, sentCsv],
      [SKIPPED_CSV_NAME, skippedCsv],
    ] as const) {
      const file = path.join(this.dir, name);

      try {
        fs.writeFileSync(file, csv, "utf-8");
        this.csvWarnings.delete(file);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";

        if (!this.csvWarnings.has(file)) {
          this.csvWarnings.add(file);
          console.warn(
            `Team Activity: could not update ${name} (${code || String(error)}); is it open in Excel? It will be updated on the next save. Sending is not affected.`,
          );
        }
      }
    }
  }

  // -------------------------------------------------------------
  // Upgrade from the earlier one-file-per-day layout
  // -------------------------------------------------------------

  private hasLegacyFiles(): boolean {
    try {
      return fs
        .readdirSync(this.dir)
        .some((name) => LEGACY_DAY_JSON.test(name) || LEGACY_DAY_CSV.test(name));
    } catch {
      // Folder missing or not a folder: nothing to migrate. (A folder
      // that can't be used is reported clearly when saving.)
      return false;
    }
  }

  // Merges YYYY-MM-DD.json files into activity-state.json (days not
  // already there), then removes them and their dated CSVs.
  private migrateLegacyFiles(): void {
    if (!this.hasLegacyFiles()) {
      return;
    }

    const legacyJson = fs
      .readdirSync(this.dir)
      .filter((n) => LEGACY_DAY_JSON.test(n));

    if (legacyJson.length > 0) {
      let current: StateFile = { version: 2, days: {} };

      if (fs.existsSync(this.file)) {
        try {
          const parsed = JSON.parse(
            fs.readFileSync(this.file, "utf-8"),
          ) as Partial<StateFile>;

          if (parsed && typeof parsed.days === "object" && parsed.days) {
            current = { version: 2, days: parsed.days as StateFile["days"] };
          }
        } catch {
          // Unreadable: leave everything for readFile() to handle;
          // don't mix in legacy data we can't reconcile.
          return;
        }
      }

      for (const name of legacyJson) {
        const date = LEGACY_DAY_JSON.exec(name)![1]!;

        try {
          const parsed = JSON.parse(
            fs.readFileSync(path.join(this.dir, name), "utf-8"),
          ) as { date?: string; records?: unknown[] };

          if (
            parsed?.date === date &&
            Array.isArray(parsed.records) &&
            !current.days[date]
          ) {
            current.days[date] = parsed.records.filter(isValidRecord);
          }
        } catch {
          // skip an unreadable legacy file
        }
      }

      // Write the merged file directly (not via readFile()).
      fs.mkdirSync(this.dir, { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(current, null, 2), "utf-8");
      fs.renameSync(temp, this.file);

      console.log(
        `Team Activity: moved ${legacyJson.length} daily state file(s) into ${STATE_FILE_NAME}.`,
      );
    }

    for (const name of fs.readdirSync(this.dir)) {
      if (LEGACY_DAY_JSON.test(name) || LEGACY_DAY_CSV.test(name)) {
        try {
          fs.rmSync(path.join(this.dir, name), { force: true });
        } catch {
          // e.g. a dated CSV open in Excel; removed on a later run
        }
      }
    }
  }

  private removeOldJunk(): void {
    let names: string[];

    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }

    const now = Date.now();

    for (const name of names) {
      if (
        !name.includes(".corrupt-") &&
        !name.endsWith(".tmp")
      ) {
        continue;
      }

      const file = path.join(this.dir, name);

      try {
        const age = now - fs.statSync(file).mtimeMs;

        // Temp files older than a minute are leftovers from a crash.
        const limit = name.endsWith(".tmp")
          ? 60_000
          : JUNK_RETENTION_MS;

        if (age > limit) {
          fs.rmSync(file, { force: true });
        }
      } catch {
        // ignore
      }
    }
  }
}

function isValidRecord(record: unknown): record is TeamActivityRecord {
  const r = record as Partial<TeamActivityRecord> | null;

  return (
    !!r &&
    typeof r.activityId === "string" &&
    typeof r.message === "string" &&
    (r.status === "pending" || r.status === "sent" || r.status === "skipped")
  );
}

// ---------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------

function toCsv(header: string[], rows: string[][]): string {
  const escape = (raw: string) => {
    // Names / projects come from people. A value starting with = + - @
    // would be run as a formula by Excel / Google Sheets, so it is
    // prefixed with ' (shown as plain text).
    const value = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;

    return /[",\r\n]/.test(value)
      ? `"${value.replace(/"/g, '""')}"`
      : value;
  };

  const lines = [header, ...rows].map((row) =>
    row.map((cell) => escape(cell ?? "")).join(","),
  );

  // BOM so Excel shows names and emojis correctly (UTF-8).
  return "﻿" + lines.join("\r\n") + "\r\n";
}

function activityLabel(type: string): string {
  switch (type) {
    case "login":
      return "Started working";
    case "project_change":
      return "Switched project";
    case "leave":
      return "On leave";
    default:
      return type;
  }
}

// "2026-09-29" → "29-09-2026" (same style as the Time Tracker)
function displayDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

// "10:44 AM" → minutes since midnight (leave rows, no time → first).
function minutesOf(timestamp: string): number {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(
    (timestamp ?? "").trim(),
  );

  if (!match) {
    return -1;
  }

  const hours = Number(match[1]) % 12;
  const pm = match[3]!.toUpperCase() === "PM";

  return (hours + (pm ? 12 : 0)) * 60 + Number(match[2]);
}

function istDateTime(iso: string | null): string {
  if (!iso) {
    return "";
  }

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(date);
}
