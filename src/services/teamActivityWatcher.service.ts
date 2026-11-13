import fs from "node:fs";

import {
  TeamActivityService,
  type TeamActivityEvent,
} from "./teamActivity.service.js";
import { googleChatService } from "../integrations/googleChat/googleChat.service.js";
import {
  TeamActivityStateStore,
  type DailyTeamActivityState,
  type TeamActivityRecord,
} from "./teamActivityState.store.js";
import { LogThrottle } from "./logThrottle.js";
import {
  DEFAULT_TEAM_ACTIVITY_POLL_INTERVAL_MS,
  resolveStatePath,
} from "../config/runtimeConfig.js";

// ---------------------------------------------------------------
// Delivery lifecycle
//
//   Time Tracker activity detected
//     → stable activity ID (see TeamActivityService.createEvent)
//     → already in today's state file?  yes → never sent again
//     → no: stored as PENDING and saved to disk
//     → sent to Google Chat
//     → Google Chat confirms → marked SENT and saved immediately
//     → any failure (429, 5xx, network) → stays PENDING, retried
//       with backoff. Records are never dropped.
//
// On restart the state file is reloaded, so SENT records are not
// replayed and PENDING records are delivered.
// ---------------------------------------------------------------

// Settings (TEAM_ACTIVITY_WATCHER_ENABLED, TEAM_ACTIVITY_POLL_INTERVAL_MS)
// live in config/runtimeConfig.ts; re-exported here for existing imports.
export {
  DEFAULT_TEAM_ACTIVITY_POLL_INTERVAL_MS,
  readTeamActivityWatcherConfig,
  type TeamActivityWatcherConfig,
} from "../config/runtimeConfig.js";

// Google Chat webhooks accept about 1 message per second per space.
const SEND_GAP_MS = 1_100;

// Retry delay after a failed send: 5s, 10s, 20s ... capped at 5 min.
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

interface ChatSender {
  sendTeamActivityMessage(message: string): Promise<void>;
}

interface ActivitySource {
  getActivity(): Promise<TeamActivityEvent[]>;
}

export interface TeamActivityWatcherOptions {
  store?: TeamActivityStateStore;
  activitySource?: ActivitySource;
  chat?: ChatSender;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  legacyLeaveStateFile?: string;
  logs?: LogThrottle;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TeamActivityWatcherService {
  private readonly store: TeamActivityStateStore;

  private readonly activitySource: ActivitySource;

  private readonly chat: ChatSender;

  private readonly now: () => Date;

  private readonly sleep: (ms: number) => Promise<void>;

  // Old leave-only state file from the previous implementation.
  // Only READ (never written) so today's leave messages already sent
  // by the old code are not sent again after upgrading.
  private readonly legacyLeaveStateFile: string;

  // Loaded day states, keyed by date. Contains today plus any
  // earlier day that still has pending records.
  private readonly states = new Map<
    string,
    DailyTeamActivityState
  >();

  private today = "";

  // First successful poll since this process started.
  private baselineDone = false;

  // How the first poll after start-up treats activity that is in the
  // Time Tracker but not yet in the state file:
  //   "catch-up"      → post it (it happened while the service was down)
  //   "fresh-install" → no state files at all yet: record, don't post
  //                     (a first deploy mid-day must not dump the day)
  //   "unreadable"    → today's file was corrupt: record, don't post
  //                     (we can't tell what was already sent)
  private startupMode: "catch-up" | "fresh-install" | "unreadable" | null =
    null;

  // Set when Google Chat returns 429: no sends until this time.
  private chatCooldownUntil = 0;

  private interval: NodeJS.Timeout | null = null;

  // Dates whose state could not be written to disk. Nothing from
  // these days is sent until the state is saved successfully.
  private readonly unsaved = new Set<string>();

  private readonly logs: LogThrottle;

  // Prevents overlapping checks. The Time Tracker API regularly
  // takes 2–3s (sometimes 20s+) and polling runs every 15s by default,
  // so without this two checks could process the same activity.
  private isChecking = false;

  // Set by stop(): no NEW send is started, so a restart/shutdown can
  // only ever interrupt the one message already in flight.
  private stopping = false;

  // True only while a message is being sent to Google Chat.
  private sendInFlight = false;

  // For /health: when the last check finished (ISO time).
  private lastCheckFinishedAt: string | null = null;

  constructor(options: TeamActivityWatcherOptions = {}) {
    this.store = options.store ?? new TeamActivityStateStore();
    this.activitySource =
      options.activitySource ?? new TeamActivityService();
    this.chat = options.chat ?? googleChatService;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? defaultSleep;
    this.logs =
      options.logs ??
      new LogThrottle(5 * 60_000, () => this.now().getTime());
    this.legacyLeaveStateFile =
      options.legacyLeaveStateFile ??
      resolveStatePath(".team-activity-leave-state.json");
  }

  start(
    intervalMs = DEFAULT_TEAM_ACTIVITY_POLL_INTERVAL_MS,
  ): void {
    if (this.interval) {
      return;
    }

    this.stopping = false;

    console.log(
      `Google Chat Team Activity watcher started (polling every ${Math.round(intervalMs / 1000)}s, state: ${this.store.directory}).`,
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
    this.stopping = true;

    console.log(
      "Google Chat Team Activity watcher stopped.",
    );
  }

  // Resolves once no message is being sent (or after `timeoutMs`).
  // Used on shutdown so a restart does not cut a send in half, which
  // is what makes a message appear twice.
  async waitForSendToFinish(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (this.sendInFlight && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // Read-only summary for the /health endpoint.
  getStatus(): {
    running: boolean;
    checking: boolean;
    lastCheckFinishedAt: string | null;
    pending: number;
  } {
    let pending = 0;

    for (const state of this.states.values()) {
      pending += state.records.filter(
        (record) => record.status === "pending",
      ).length;
    }

    return {
      running: this.interval !== null,
      checking: this.isChecking,
      lastCheckFinishedAt: this.lastCheckFinishedAt,
      pending,
    };
  }

  async check(): Promise<void> {
    if (this.isChecking) {
      return;
    }

    this.isChecking = true;

    try {
      this.ensureDay();

      let activities: TeamActivityEvent[] | null = null;

      try {
        activities = await this.activitySource.getActivity();

        this.logs.success(
          "time-tracker",
          "Team Activity: Time Tracker is reachable again.",
        );
      } catch (error) {
        // Keep going: pending records can still be delivered.
        this.logs.failure(
          "time-tracker",
          "Team Activity: could not read Time Tracker; will retry on the next poll.",
          error,
        );
      }

      // The day may have changed while the fetch was running.
      this.ensureDay();

      // Retry saving any state that previously failed to save.
      this.flushUnsaved();

      if (activities) {
        this.recordNewActivities(activities);
      }

      await this.deliverPending();
    } catch (error) {
      this.logs.failure(
        "watcher",
        "Team Activity watcher error:",
        error,
      );
    } finally {
      this.isChecking = false;
      this.lastCheckFinishedAt = this.now().toISOString();
    }
  }

  // -------------------------------------------------------------
  // Day handling, loading and cleanup
  // -------------------------------------------------------------

  private ensureDay(): void {
    const today = this.getToday(this.now());

    if (today === this.today) {
      return;
    }

    const isStartup = this.today === "";

    if (isStartup && this.startupMode === null) {
      let hasAnyState = false;

      try {
        hasAnyState = this.store.listDates().length > 0;
      } catch {
        hasAnyState = false;
      }

      this.startupMode = hasAnyState ? "catch-up" : "fresh-install";
    }

    if (!this.states.has(today)) {
      // Throws if the file exists but cannot be read (e.g. no
      // permission). Then nothing is sent until it can be read,
      // because we can't tell what was already delivered.
      const { state, existed, corrupt } =
        this.store.load(today);

      this.states.set(today, state);

      if (isStartup && corrupt) {
        this.startupMode = "unreadable";
      }

      this.warnAboutInterruptedSends(state);

      // Create the day's file right away (also replaces a
      // quarantined corrupt file with a valid one). For an existing
      // file, make sure its readable CSV copies are there too.
      if (!existed) {
        this.persist(state);
      } else {
        this.store.writeReadableCopies(state);
      }

      if (isStartup) {
        console.log(
          existed
            ? `Team Activity state loaded for ${today}: ${this.describe(state)}.`
            : corrupt
              ? `Team Activity state for ${today} was unreadable; starting fresh (existing activity will not be replayed).`
              : this.startupMode === "fresh-install"
                ? `Team Activity state for ${today} created (first run: activity that already exists will not be posted).`
                : `Team Activity state for ${today} created.`,
        );
      }
    }

    this.today = today;

    // Forget days that no longer have pending work, then delete
    // their files. Days with pending records are kept and loaded
    // so those records are still delivered.
    for (const [date, state] of this.states) {
      if (
        date < today &&
        !state.records.some((r) => r.status === "pending")
      ) {
        this.states.delete(date);
      }
    }

    let deleted: string[] = [];
    let retained: string[] = [];

    try {
      ({ deleted, retained } = this.store.cleanup(today));
    } catch (error) {
      // Cleanup is housekeeping only; never block delivery on it.
      this.logs.failure(
        "state-cleanup",
        `Team Activity: could not clean up old state files in ${this.store.directory} (will retry tomorrow).`,
        error,
        { level: "warn" },
      );
    }

    for (const date of retained) {
      if (!this.states.has(date)) {
        const { state } = this.store.load(date);
        this.states.set(date, state);
        this.warnAboutInterruptedSends(state);
      }

      console.warn(
        `Team Activity state for ${date} kept: it still has undelivered records.`,
      );
    }

    if (deleted.length > 0) {
      console.log(
        `Team Activity state cleaned up for: ${deleted.join(", ")}.`,
      );
    }
  }

  private warnAboutInterruptedSends(
    state: DailyTeamActivityState,
  ): void {
    for (const record of state.records) {
      if (
        record.status === "pending" &&
        record.sendStartedAt
      ) {
        // The process stopped while this message was in flight.
        // Google Chat may or may not have received it; resending
        // guarantees it is not lost (it may appear twice).
        console.warn(
          `Team Activity: delivery of "${record.message}" was interrupted by a restart; it will be resent.`,
        );

        record.sendStartedAt = null;
      }
    }
  }

  // -------------------------------------------------------------
  // Detection → PENDING
  // -------------------------------------------------------------

  private recordNewActivities(
    activities: TeamActivityEvent[],
  ): void {
    const isBaseline = !this.baselineDone;

    // After a restart, activity missed while the service was down is
    // posted (catch-up). Only on a brand-new install or with an
    // unreadable state file is existing activity recorded unposted.
    const skipExisting =
      isBaseline && this.startupMode !== "catch-up";
    let caughtUp = 0;

    const legacyLeaveIds = isBaseline
      ? this.readLegacyLeaveIds()
      : new Set<string>();

    const nowIso = this.now().toISOString();
    const changed = new Set<DailyTeamActivityState>();
    const known = new Map<string, Set<string>>();

    for (const activity of activities) {
      // Each record is stored in the file for its own date. Normally
      // that is today; around midnight a fetch that started before
      // midnight can still return yesterday's activity.
      const date = this.getActivityDate(activity) ?? this.today;

      if (date > this.today) {
        continue;
      }

      const state = this.getOrLoadState(date);

      let ids = known.get(date);

      if (!ids) {
        ids = new Set(
          state.records.map((record) => record.activityId),
        );
        known.set(date, ids);
      }

      // Already recorded (sent, pending or skipped) → nothing to do.
      // This also collapses duplicates within one Time Tracker
      // response.
      if (ids.has(activity.id)) {
        continue;
      }

      // One leave message per person per day, whichever source (Keka or
      // the Time Tracker) reported it first, even if the two systems have
      // a different email for the same person: match by name as well.
      if (
        activity.type === "leave" &&
        state.records.some(
          (record) =>
            record.type === "leave" &&
            record.employee.trim().toLowerCase() ===
              String(activity.name ?? "").trim().toLowerCase(),
        )
      ) {
        ids.add(activity.id);
        continue;
      }

      ids.add(activity.id);

      let status: TeamActivityRecord["status"] = "pending";

      if (isBaseline) {
        if (
          activity.type === "leave" &&
          legacyLeaveIds.has(activity.id)
        ) {
          // Already announced by the previous implementation.
          status = "sent";
        } else if (skipExisting) {
          // First run / unreadable state: remember, don't announce.
          // Applies to leave too: it is just another activity, and
          // replaying existing leaves would post them all as one block.
          status = "skipped";
        } else {
          caughtUp++;
        }
      }

      state.records.push(
        this.createRecord(activity, status, nowIso),
      );

      changed.add(state);
    }

    this.baselineDone = true;

    // Persist PENDING records BEFORE sending anything. If this
    // fails, the records stay in memory as pending but nothing is
    // sent until the state has been saved (see deliverPending).
    for (const state of changed) {
      this.persist(state);
    }

    if (isBaseline) {
      console.log(
        `Team Activity watcher initialized with ${activities.length} existing activities.`,
      );

      if (caughtUp > 0) {
        console.log(
          `Team Activity: ${caughtUp} activities happened while the service was down; posting them now.`,
        );
      }
    }
  }

  private getOrLoadState(
    date: string,
  ): DailyTeamActivityState {
    let state = this.states.get(date);

    if (!state) {
      state = this.store.load(date).state;
      this.warnAboutInterruptedSends(state);
      this.states.set(date, state);
    }

    return state;
  }

  // "24-09-2026" → "2026-09-24"
  private getActivityDate(
    activity: TeamActivityEvent,
  ): string | null {
    const [day, month, year] = (
      activity.dateSubmitted ?? ""
    ).split("-");

    if (!day || !month || !year) {
      return null;
    }

    return `${year}-${month}-${day}`;
  }

  private createRecord(
    activity: TeamActivityEvent,
    status: TeamActivityRecord["status"],
    nowIso: string,
  ): TeamActivityRecord {
    const icon =
      activity.icon ?? (activity.type === "leave" ? "🔴" : "🟢");

    return {
      activityId: activity.id,
      type: activity.type,
      employee: activity.name,
      email: activity.email,
      fromProject: activity.previousProject,
      toProject: activity.project,
      timestamp: this.formatTime(activity.startTime),
      message: `${icon} ${activity.message}`,
      status,
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
      sendStartedAt: null,
      detectedAt: nowIso,
      sentAt: status === "sent" ? nowIso : null,
    };
  }

  // -------------------------------------------------------------
  // PENDING → SENT
  // -------------------------------------------------------------

  private async deliverPending(): Promise<void> {
    let sentThisRound = 0;

    // Oldest day first, then in detection order.
    const dates = [...this.states.keys()].sort();

    for (const date of dates) {
      const state = this.states.get(date);

      if (!state) {
        continue;
      }

      if (this.unsaved.has(date)) {
        // Pending records for this day are not safely on disk yet.
        continue;
      }

      for (const record of state.records) {
        if (record.status !== "pending") {
          continue;
        }

        if (this.stopping) {
          // Shutting down: leave the rest PENDING for the next start.
          return;
        }

        const now = this.now().getTime();

        if (now < this.chatCooldownUntil) {
          return;
        }

        if (
          record.nextAttemptAt &&
          now < Date.parse(record.nextAttemptAt)
        ) {
          continue;
        }

        if (sentThisRound > 0) {
          await this.sleep(SEND_GAP_MS);
        }

        const result = await this.deliver(state, record);

        if (result === "blocked") {
          // State can't be saved: stop sending until it can.
          return;
        }

        sentThisRound++;

        if (
          result === "failed" &&
          this.chatCooldownUntil > now
        ) {
          // Rate limited: stop this round, try again later.
          return;
        }
      }

      if (
        date < this.today &&
        !state.records.some((r) => r.status === "pending")
      ) {
        // Earlier day fully delivered: safe to delete now.
        this.states.delete(date);

        try {
          this.store.delete(date);
        } catch (error) {
          this.logs.failure(
            "state-cleanup",
            `Team Activity: could not delete old state file ${date}.json (it will be retried at the next cleanup).`,
            error,
            { level: "warn" },
          );
        }

        console.log(
          `Team Activity state for ${date} delivered and cleaned up.`,
        );
      }
    }
  }

  private async deliver(
    state: DailyTeamActivityState,
    record: TeamActivityRecord,
  ): Promise<"sent" | "failed" | "blocked"> {
    // Mark as in-flight on disk first so a crash during the send is
    // detectable after restart. If that can't be saved, don't send.
    record.sendStartedAt = this.now().toISOString();

    if (!this.persist(state)) {
      record.sendStartedAt = null;
      return "blocked";
    }

    this.sendInFlight = true;

    try {
      await this.chat.sendTeamActivityMessage(record.message);
    } catch (error) {
      this.sendInFlight = false;

      const message =
        error instanceof Error ? error.message : String(error);

      record.attempts += 1;
      record.lastError = message.slice(0, 500);
      record.sendStartedAt = null;

      const delay = Math.min(
        RETRY_BASE_MS * 2 ** (record.attempts - 1),
        RETRY_MAX_MS,
      );

      record.nextAttemptAt = new Date(
        this.now().getTime() + delay,
      ).toISOString();

      if (/\b429\b/.test(message)) {
        this.chatCooldownUntil =
          this.now().getTime() + delay;
      }

      // Stays PENDING — never marked sent on failure. (If this save
      // fails too, the record is still pending in the file.)
      this.persist(state);

      this.logs.failure(
        "chat",
        "Team Activity: Google Chat send failed; the activity is kept as pending and will be retried (backoff up to 5 min).",
        error,
        {
          detail: `attempt ${record.attempts}, next try in ${Math.round(delay / 1000)}s: ${record.message}`,
        },
      );

      return "failed";
    }

    this.sendInFlight = false;

    this.logs.success(
      "chat",
      "Team Activity: Google Chat delivery is working again.",
    );

    // Google Chat confirmed delivery.
    record.status = "sent";
    record.sentAt = this.now().toISOString();
    record.sendStartedAt = null;
    record.lastError = null;
    record.nextAttemptAt = null;

    if (this.persist(state)) {
      console.log(`Team Activity sent: ${record.message}`);
    } else {
      // Delivered, but the SENT status is not on disk yet. It won't be
      // resent while this process runs (memory says sent) and saving
      // is retried every poll; only a restart before that succeeds
      // could resend it.
      console.error(
        `Team Activity sent, but its SENT status could NOT be saved yet (will keep retrying): ${record.message}`,
      );
    }

    return "sent";
  }

  // Saves a day's state. Returns false (and logs a clear, throttled
  // error) instead of throwing when the disk write fails.
  private persist(state: DailyTeamActivityState): boolean {
    try {
      this.store.save(state);
    } catch (error) {
      this.unsaved.add(state.date);

      this.logs.failure(
        "state-write",
        `Team Activity: could NOT save delivery state to ${this.store.directory}. New activity will NOT be sent until it can be saved. Check the folder exists and is writable and the disk is not full (set TEAM_ACTIVITY_STATE_DIR to change the location).`,
        error,
      );

      return false;
    }

    if (this.unsaved.delete(state.date)) {
      this.logs.success(
        "state-write",
        `Team Activity: delivery state saved again to ${this.store.directory}.`,
      );
    }

    return true;
  }

  private flushUnsaved(): void {
    for (const date of [...this.unsaved]) {
      const state = this.states.get(date);

      if (state) {
        this.persist(state);
      } else {
        this.unsaved.delete(date);
      }
    }
  }

  // -------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------

  private readLegacyLeaveIds(): Set<string> {
    try {
      if (!fs.existsSync(this.legacyLeaveStateFile)) {
        return new Set();
      }

      const ids = JSON.parse(
        fs.readFileSync(this.legacyLeaveStateFile, "utf-8"),
      );

      return new Set(
        Array.isArray(ids)
          ? ids.filter(
              (id): id is string => typeof id === "string",
            )
          : [],
      );
    } catch {
      return new Set();
    }
  }

  private describe(state: DailyTeamActivityState): string {
    const count = (status: string) =>
      state.records.filter((r) => r.status === status).length;

    return `${count("sent")} sent, ${count("pending")} pending, ${count("skipped")} skipped`;
  }

  // Current date in India time (same as TeamActivityService).
  private getToday(date: Date): string {
    const parts: Record<string, string> = {};

    for (const part of new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date)) {
      if (part.type !== "literal") {
        parts[part.type] = part.value;
      }
    }

    return `${parts.year ?? ""}-${parts.month ?? ""}-${parts.day ?? ""}`;
  }

  private formatTime(value: string): string {
    const [h, m] = (value ?? "").split(":");
    const hours = Number(h);
    const minutes = Number(m);

    if (!value || Number.isNaN(hours) || Number.isNaN(minutes)) {
      return value ?? "";
    }

    const period = hours >= 12 ? "PM" : "AM";

    return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${period}`;
  }
}

export const teamActivityWatcher =
  new TeamActivityWatcherService();
