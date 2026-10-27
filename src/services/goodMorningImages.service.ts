import fs from "node:fs";
import path from "node:path";

import { resolveStatePath } from "../config/runtimeConfig.js";

// ---------------------------------------------------------------
// Good Morning picture rotation.
//
// Keep a list of picture links in ONE text file in the state folder:
//
//   <STATE_DIR>/good-morning-images.txt      one https link per line
//                                            (blank lines and lines
//                                            starting with # are ignored)
//
// Each weekday the next picture that has not been used yet is chosen
// (in the order of the file). Only after Google Chat has really accepted
// the message is that picture moved to "sent". When every picture has
// been used, "sent" becomes the list again and the round starts over.
//
//   - The same picture is used for the whole day: retries, restarts and a
//     failed send never change it, and nothing is used up until the
//     message is really delivered.
//   - Edit the list any time: new links join the current round, removed
//     links disappear from "sent" too.
//   - No list file (or no valid link in it): the old single picture,
//     GOOD_MORNING_IMAGE_URL, is used exactly as before.
//
// Files in the state folder:
//   good-morning-images.txt          the list (you upload / edit this)
//   good-morning-images-status.txt   readable: NEXT, sent, still to send
//   .good-morning-images-state.json  the service's own memory
// ---------------------------------------------------------------

export const IMAGE_LIST_FILE = "good-morning-images.txt";
export const IMAGE_STATUS_FILE = "good-morning-images-status.txt";
export const IMAGE_STATE_FILE = ".good-morning-images-state.json";

interface ImageState {
  // Pictures already used in the current round.
  sent: string[];
  // The picture chosen for this India date, and the date.
  todayDate: string;
  todayImage: string;
  // How many full rounds have been completed.
  rounds: number;
}

export interface ImageChoice {
  url: string;
  // "list" = from good-morning-images.txt, "fallback" = GOOD_MORNING_IMAGE_URL
  source: "list" | "fallback";
}

export interface ImageStatus {
  source: "list" | "fallback" | "none";
  listed: number;
  sentThisRound: number;
  remainingThisRound: number;
  rounds: number;
  // The picture the next message will use.
  next: string | null;
}

// India date, "YYYY-MM-DD".
function indiaDate(at: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Text of the list file → valid, de-duplicated https links, in order.
// Anything else is skipped and reported in `warnings`.
export function parseImageList(
  text: string,
  warnings: string[] = [],
): string[] {
  const links: string[] = [];

  text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .forEach((rawLine, index) => {
      const line = rawLine.trim();

      if (line === "" || line.startsWith("#")) {
        return;
      }

      let url: URL | null = null;

      try {
        url = new URL(line);
      } catch {
        url = null;
      }

      if (!url || url.protocol !== "https:" || !url.hostname) {
        warnings.push(
          `Line ${index + 1} of ${IMAGE_LIST_FILE} is not an https link and was skipped.`,
        );
        return;
      }

      if (!links.includes(line)) {
        links.push(line);
      }
    });

  return links;
}

export interface ImagePickerOptions {
  // Default: <STATE_DIR>/good-morning-images.txt etc., looked up on each
  // call so a changed STATE_DIR is honoured.
  listFile?: string;
  stateFile?: string;
  statusFile?: string;
  now?: () => Date;
  // The old single picture. Default: GOOD_MORNING_IMAGE_URL.
  fallbackUrl?: () => string | undefined;
}

export class GoodMorningImagePicker {
  private readonly options: ImagePickerOptions;

  private lastWarning = "";

  constructor(options: ImagePickerOptions = {}) {
    this.options = options;
  }

  private get listFile(): string {
    return this.options.listFile ?? resolveStatePath(IMAGE_LIST_FILE);
  }

  private get stateFile(): string {
    return this.options.stateFile ?? resolveStatePath(IMAGE_STATE_FILE);
  }

  private get statusFile(): string {
    return this.options.statusFile ?? resolveStatePath(IMAGE_STATUS_FILE);
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private fallback(): string | undefined {
    const value = (
      this.options.fallbackUrl
        ? this.options.fallbackUrl()
        : process.env.GOOD_MORNING_IMAGE_URL
    )?.trim();

    return value || undefined;
  }

  // The links currently in the list file (empty when there is no usable list).
  private readList(): string[] {
    let text: string;

    try {
      text = fs.readFileSync(this.listFile, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`Could not read ${IMAGE_LIST_FILE}:`, error);
      }

      return [];
    }

    const warnings: string[] = [];
    const links = parseImageList(text, warnings);
    const summary = warnings.join(" ");

    // Say it once per change, not every 30 seconds.
    if (summary !== this.lastWarning) {
      this.lastWarning = summary;

      if (summary) {
        console.warn(`Good Morning pictures: ${summary}`);
      }
    }

    if (links.length === 0 && text.trim() !== "") {
      console.warn(
        `Good Morning pictures: ${IMAGE_LIST_FILE} has no usable link; using GOOD_MORNING_IMAGE_URL instead.`,
      );
    }

    return links;
  }

  private loadState(): ImageState {
    try {
      const data = JSON.parse(
        fs.readFileSync(this.stateFile, "utf-8"),
      ) as Partial<ImageState>;

      return {
        sent: Array.isArray(data.sent)
          ? data.sent.filter((v): v is string => typeof v === "string")
          : [],
        todayDate: typeof data.todayDate === "string" ? data.todayDate : "",
        todayImage: typeof data.todayImage === "string" ? data.todayImage : "",
        rounds: typeof data.rounds === "number" ? data.rounds : 0,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(
          `Could not read the Good Morning pictures memory (${IMAGE_STATE_FILE}); starting a fresh round:`,
          error,
        );
      }

      return { sent: [], todayDate: "", todayImage: "", rounds: 0 };
    }
  }

  private saveState(state: ImageState, list: string[]): void {
    try {
      // Temp file then rename, so a crash cannot leave a broken file.
      const temp = `${this.stateFile}.tmp`;

      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(state, null, 2), "utf-8");
      fs.renameSync(temp, this.stateFile);
    } catch (error) {
      console.error(
        `Failed to save the Good Morning pictures memory to ${this.stateFile}. Today's picture is still used; check the folder is writable.`,
        error,
      );
    }

    this.writeStatus(state, list);
  }

  // A plain-text copy anyone can open over FTP.
  private writeStatus(state: ImageState, list: string[]): void {
    try {
      const sent = state.sent.filter((url) => list.includes(url));
      const remaining = list.filter((url) => !sent.includes(url));
      const next = state.todayImage || remaining[0] || list[0] || "";

      const lines = [
        "Good Morning pictures (rotation)",
        `Updated: ${this.now().toISOString()}`,
        "",
        `Pictures in ${IMAGE_LIST_FILE}: ${list.length}`,
        `Already sent this round: ${sent.length}`,
        `Still to send this round: ${remaining.length}`,
        `Rounds completed: ${state.rounds}`,
        "",
        `Picture for ${state.todayDate || "the next weekday"}:`,
        next,
        "",
        "SENT THIS ROUND (oldest first):",
        ...sent.map((url, i) => `${i + 1}. ${url}`),
        "",
        "STILL TO SEND (in order):",
        ...remaining.map((url, i) => `${i + 1}. ${url}`),
        "",
      ];

      fs.mkdirSync(path.dirname(this.statusFile), { recursive: true });
      fs.writeFileSync(this.statusFile, lines.join("\n"), "utf-8");
    } catch {
      // Informational only.
    }
  }

  // The picture for today's message. Throws when there is neither a usable
  // list nor GOOD_MORNING_IMAGE_URL. Does NOT use anything up: call
  // markSent() after Google Chat has accepted the message.
  pick(): ImageChoice {
    const list = this.readList();

    if (list.length === 0) {
      const fallback = this.fallback();

      if (!fallback) {
        throw new Error("GOOD_MORNING_IMAGE_URL is not configured");
      }

      return { url: fallback, source: "fallback" };
    }

    const today = indiaDate(this.now());
    const state = this.loadState();

    // Links that were removed from the list are forgotten.
    state.sent = state.sent.filter((url) => list.includes(url));

    // Same day = same picture (retries, restarts, a failed send).
    if (
      state.todayDate === today &&
      state.todayImage &&
      list.includes(state.todayImage)
    ) {
      return { url: state.todayImage, source: "list" };
    }

    let pool = list.filter((url) => !state.sent.includes(url));

    if (pool.length === 0) {
      // Everything was used: sent becomes the list again.
      state.sent = [];
      state.rounds += 1;
      pool = [...list];

      console.log(
        `Good Morning pictures: all ${list.length} have been used; starting a new round.`,
      );
    }

    state.todayDate = today;
    state.todayImage = pool[0]!;

    this.saveState(state, list);

    console.log(
      `Good Morning picture for ${today}: ${list.length - pool.length + 1} of ${list.length} this round (${pool.length - 1} left after it).`,
    );

    return { url: state.todayImage, source: "list" };
  }

  // Call after Google Chat accepted the message: the picture is used up.
  markSent(choice: ImageChoice): void {
    if (choice.source !== "list") {
      return;
    }

    const list = this.readList();
    const state = this.loadState();

    if (list.includes(choice.url) && !state.sent.includes(choice.url)) {
      state.sent = [...state.sent.filter((url) => list.includes(url)), choice.url];
    }

    this.saveState(state, list);
  }

  // What the next message will use. Changes nothing (used by /health).
  peek(): ImageStatus {
    const list = this.readList();

    if (list.length === 0) {
      const fallback = this.fallback();

      return {
        source: fallback ? "fallback" : "none",
        listed: 0,
        sentThisRound: 0,
        remainingThisRound: 0,
        rounds: 0,
        next: fallback ?? null,
      };
    }

    const state = this.loadState();
    const sent = state.sent.filter((url) => list.includes(url));
    const remaining = list.filter((url) => !sent.includes(url));
    const today = indiaDate(this.now());

    const next =
      state.todayDate === today && list.includes(state.todayImage)
        ? state.todayImage
        : (remaining[0] ?? list[0]!);

    return {
      source: "list",
      listed: list.length,
      sentThisRound: sent.length,
      remainingThisRound: remaining.length,
      rounds: state.rounds,
      next,
    };
  }
}

export const goodMorningImages = new GoodMorningImagePicker();
