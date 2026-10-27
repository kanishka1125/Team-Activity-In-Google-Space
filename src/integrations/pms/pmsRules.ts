// ---------------------------------------------------------------
// PMS task-allocation rules (READ-ONLY, no I/O).
//
// Shared constants and the due-date parser for the (separate) Keka-based
// unallocated report in services/unallocated.service.ts.
// ---------------------------------------------------------------

// PMS statuses (live data: Backlog, To Do, In Progress, Done, Closed).
export const OPEN_STATUSES = new Set(["backlog", "to do", "in progress"]);
export const TERMINAL_STATUSES = new Set(["done", "closed"]);

// "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM[:SS]" (no time zone) → "YYYY-MM-DD",
// or null when empty / not a real calendar date. The time part is
// ignored: a task due at any time today still counts for today.
export function parsePmsDueDate(value: unknown): string | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.exec(
      String(value ?? "").trim(),
    );

  if (!match) {
    return null;
  }

  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));

  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(m) - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    return null;
  }

  return `${y}-${m}-${d}`;
}
