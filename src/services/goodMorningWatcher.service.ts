import fs from "node:fs";
import path from "node:path";

import { googleChatService } from "../integrations/googleChat/googleChat.service.js";
import { quoteService } from "./quote.service.js";
import { LogThrottle } from "./logThrottle.js";
import { resolveStatePath } from "../config/runtimeConfig.js";

interface GoodMorningState {
  lastSentDate: string;
}

// Scheduled time (IST) and how long after it we keep trying if the
// first attempt fails (e.g. Google Chat 429 or a restart at 9:30).
const SEND_HOUR = 9;
const SEND_MINUTE = 30;
const DELIVERY_WINDOW_MINUTES = 30; // 9:30 – 10:00

// Wait between attempts after a failure.
const RETRY_DELAY_MS = 60_000;

interface GoodMorningOptions {
  now?: () => Date;
  stateFile?: string;
  sendMessage?: (message: string) => Promise<void>;
  getQuote?: () => Promise<{ quote: string }>;
}

export class GoodMorningWatcherService {
  private readonly stateFile: string;

  private readonly now: () => Date;

  private readonly sendMessage: (message: string) => Promise<void>;

  private readonly getQuote: () => Promise<{ quote: string }>;

  private interval: NodeJS.Timeout | null = null;

  private state: GoodMorningState = {
    lastSentDate: "",
  };

  // Prevents overlapping checks while a send is in progress.
  private isChecking = false;

  // After a failed attempt, don't retry before this time.
  private nextAttemptAt = 0;

  private failedAttempts = 0;

  // Date for which "not sent" was already reported.
  private missedReportedFor = "";

  private readonly logs: LogThrottle;

  constructor(options: GoodMorningOptions = {}) {
    this.stateFile =
      options.stateFile ??
      resolveStatePath(".good-morning-state.json");
    this.now = options.now ?? (() => new Date());
    this.sendMessage =
      options.sendMessage ??
      ((message) =>
        googleChatService.sendGoodMorningMessage(message));
    this.getQuote =
      options.getQuote ?? (() => quoteService.getDailyQuote());
    this.logs = new LogThrottle(5 * 60_000, () =>
      this.now().getTime(),
    );

    this.loadState();
  }

  start(intervalMs = 30_000): void {
    if (this.interval) {
      return;
    }

    console.log(
      "Good Morning watcher started.",
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

    console.log(
      "Good Morning watcher stopped.",
    );
  }

  async check(): Promise<void> {
    if (this.isChecking) {
      return;
    }

    this.isChecking = true;

    try {
      const now = this.getIndiaTime();

      // Monday = 1, Friday = 5.
      // Do not send on Saturday or Sunday.
      if (
        now.dayOfWeek === 0 ||
        now.dayOfWeek === 6
      ) {
        return;
      }

      // Send at 9:30 AM IST. If that attempt fails (or the backend
      // was down at 9:30), keep trying until 10:00 AM.
      const minutes = now.hour * 60 + now.minute;
      const windowStart = SEND_HOUR * 60 + SEND_MINUTE;
      const windowEnd = windowStart + DELIVERY_WINDOW_MINUTES;

      // Prevent duplicate messages on the same day.
      if (
        this.state.lastSentDate === now.date
      ) {
        return;
      }

      if (minutes < windowStart) {
        return;
      }

      if (minutes >= windowEnd) {
        if (
          this.failedAttempts > 0 &&
          this.missedReportedFor !== now.date
        ) {
          this.missedReportedFor = now.date;

          console.error(
            `Good Morning message was NOT sent for ${now.date}: all ${this.failedAttempts} attempts between 9:30 and 10:00 failed.`,
          );
        }

        return;
      }

      if (this.now().getTime() < this.nextAttemptAt) {
        return;
      }

      try {
        // The quote is saved per day, so every retry uses the same one.
        const quote = await this.getQuote();

        const message =
          `Good Morning Team☀️\n\n${quote.quote}`;

        await this.sendMessage(message);
      } catch (error) {
        this.failedAttempts += 1;
        this.nextAttemptAt =
          this.now().getTime() + RETRY_DELAY_MS;

        this.logs.failure(
          "good-morning",
          `Good Morning message could not be sent; retrying every ${RETRY_DELAY_MS / 1000}s until 10:00 AM.`,
          error,
        );

        return;
      }

      // Remember in memory FIRST so this process can never send a
      // second message today, even if saving the file fails.
      this.state.lastSentDate = now.date;

      this.saveState();

      this.logs.success(
        "good-morning",
        "Good Morning: Google Chat delivery succeeded",
      );

      console.log(
        `Good Morning message sent for ${now.date}.`,
      );

      this.failedAttempts = 0;
      this.nextAttemptAt = 0;
    } catch (error) {
      this.logs.failure(
        "good-morning-watcher",
        "Good Morning watcher error:",
        error,
      );
    } finally {
      this.isChecking = false;
    }
  }

  private getIndiaTime(): {
    date: string;
    hour: number;
    minute: number;
    dayOfWeek: number;
  } {
    const parts = new Intl.DateTimeFormat(
      "en-IN",
      {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        weekday: "short",
      },
    ).formatToParts(this.now());

    const values: Record<string, string> = {};

    for (const part of parts) {
      if (part.type !== "literal") {
        values[part.type] = part.value;
      }
    }

    const year = values.year ?? "";
    const month = values.month ?? "";
    const day = values.day ?? "";

    const weekday = values.weekday ?? "";

    const dayOfWeekMap: Record<
      string,
      number
    > = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };

    return {
      date: `${year}-${month}-${day}`,
      hour: Number(values.hour ?? 0),
      minute: Number(values.minute ?? 0),
      dayOfWeek:
        dayOfWeekMap[weekday] ?? -1,
    };
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.stateFile)) {
        return;
      }

      const raw = fs.readFileSync(
        this.stateFile,
        "utf-8",
      );

      const data =
        JSON.parse(raw) as Partial<GoodMorningState>;

      if (
        typeof data.lastSentDate === "string"
      ) {
        this.state.lastSentDate =
          data.lastSentDate;
      }
    } catch (error) {
      console.error(
        "Failed to load Good Morning state:",
        error,
      );
    }
  }

  private saveState(): void {
    try {
      // Write to a temp file then rename, so a crash mid-write can't
      // leave a broken file (which would allow a second message).
      const tempFile = `${this.stateFile}.tmp`;

      fs.mkdirSync(path.dirname(this.stateFile), {
        recursive: true,
      });

      fs.writeFileSync(
        tempFile,
        JSON.stringify(
          this.state,
          null,
          2,
        ),
        "utf-8",
      );

      fs.renameSync(tempFile, this.stateFile);
    } catch (error) {
      console.error(
        `Failed to save Good Morning state to ${this.stateFile}. Today's message WAS sent; it won't be sent again while the backend keeps running, but could be sent again if the backend restarts before 10:00 AM. Check the folder is writable and the disk is not full.`,
        error,
      );
    }
  }
}

export const goodMorningWatcher =
  new GoodMorningWatcherService();
