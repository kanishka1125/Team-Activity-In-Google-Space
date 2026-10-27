import fs from "node:fs";
import path from "node:path";

import { getStateDir } from "../config/runtimeConfig.js";

// Restart without server access.
//
// Upload an (empty) file named restart-now.txt into the state folder.
// The service sees it, deletes it, stops cleanly (finishing any send)
// and exits. run.cmd starts it again about 10 seconds later, now using
// the files that were uploaded.
//
// Opt-in by file only: nothing happens unless the file appears. It is
// removed BEFORE stopping, and if it cannot be removed the service does
// not stop — otherwise it would restart forever.
export const RESTART_FLAG_FILE = "restart-now.txt";

const DEFAULT_POLL_MS = 15_000;

export interface RestartFlagOptions {
  directory?: string;
  pollMs?: number;
  onRestart: () => void;
}

export class RestartFlagWatcher {
  private readonly file: string;
  private readonly pollMs: number;
  private readonly onRestart: () => void;
  private timer: NodeJS.Timeout | null = null;
  private warnedAboutDelete = false;

  constructor(options: RestartFlagOptions) {
    this.file = path.join(
      options.directory ?? getStateDir(),
      RESTART_FLAG_FILE,
    );
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.onRestart = options.onRestart;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    // A flag uploaded before this start belongs to the restart that is
    // happening right now; it must not trigger another one.
    if (fs.existsSync(this.file) && this.removeFlag()) {
      console.log(
        `Old ${RESTART_FLAG_FILE} removed at start-up.`,
      );
    }

    this.timer = setInterval(() => this.check(), this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  check(): void {
    if (!fs.existsSync(this.file)) {
      return;
    }

    if (!this.removeFlag()) {
      return;
    }

    console.log(
      `${RESTART_FLAG_FILE} found: restarting to load the uploaded files.`,
    );

    this.stop();
    this.onRestart();
  }

  private removeFlag(): boolean {
    try {
      fs.unlinkSync(this.file);
      this.warnedAboutDelete = false;
      return true;
    } catch (error) {
      if (!this.warnedAboutDelete) {
        this.warnedAboutDelete = true;
        console.warn(
          `${RESTART_FLAG_FILE} exists but could not be deleted, so the service will NOT restart (it would restart forever): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      return false;
    }
  }
}
