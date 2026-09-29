// Keeps repeated identical errors from flooding the logs.
//
// - The first failure is logged in full.
// - While the SAME problem keeps happening, it is logged again at
//   most once every `repeatMs`, with a count of how many times it
//   occurred in between.
// - A different error for the same key is logged immediately.
// - When the problem goes away, one "recovered" line is logged.
export class LogThrottle {
  private readonly problems = new Map<
    string,
    {
      signature: string;
      count: number;
      firstAt: number;
      lastLoggedAt: number;
      suppressed: number;
    }
  >();

  constructor(
    private readonly repeatMs = 5 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // `detail` is printed but NOT used to decide whether two failures
  // are "the same" (e.g. which activity was being sent).
  failure(
    key: string,
    message: string,
    error?: unknown,
    options: { level?: "error" | "warn"; detail?: string } = {},
  ): void {
    const level = options.level ?? "error";
    const text = options.detail
      ? `${message} [${options.detail}]`
      : message;
    const signature = `${message}|${describeError(error)}`;
    const now = this.now();
    const existing = this.problems.get(key);
    const log = level === "warn" ? console.warn : console.error;

    if (!existing || existing.signature !== signature) {
      this.problems.set(key, {
        signature,
        count: 1,
        firstAt: existing?.firstAt ?? now,
        lastLoggedAt: now,
        suppressed: 0,
      });

      if (error === undefined) {
        log(text);
      } else {
        log(text, error);
      }

      return;
    }

    existing.count += 1;

    if (now - existing.lastLoggedAt < this.repeatMs) {
      existing.suppressed += 1;
      return;
    }

    const minutes = Math.round((now - existing.firstAt) / 60_000);

    log(
      `${text} (still failing: ${existing.count} times over ${minutes} min, ${existing.suppressed} identical messages suppressed)`,
      describeError(error),
    );

    existing.lastLoggedAt = now;
    existing.suppressed = 0;
  }

  success(key: string, message: string): void {
    const existing = this.problems.get(key);

    if (!existing) {
      return;
    }

    this.problems.delete(key);

    console.log(
      `${message} (recovered after ${existing.count} failure${existing.count === 1 ? "" : "s"})`,
    );
  }
}

function describeError(error: unknown): string {
  if (error === undefined) {
    return "";
  }

  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code}: ${error.message}` : error.message;
  }

  return String(error);
}
