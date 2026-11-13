import {
  KekaClient,
  type KekaEmployee,
  type KekaLeaveRequest,
} from "../integrations/keka/keka.client.js";

// ---------------------------------------------------------------
// Who is on leave on a given day, from Keka (read-only).
//
// Keka is the source of leave. A leave request such as 12 → 16 covers every
// day in the range, so the person is on leave on each of those days (callers
// only use this on working days).
//
// A person is on leave on a day when BOTH halves of that day are covered by
// a pending or approved request (a lone half-day still has to log).
// Rejected / cancelled / withdrawn requests are not leave.
// ---------------------------------------------------------------

export interface LeavePerson {
  name: string;
  // Lower case.
  email: string;
  // Which part of the day: the whole day, or only one half.
  part?: "full" | "first" | "second";
}

const LEAVE_STATUSES = new Set([0, 1]);

const normEmail = (value: unknown) => String(value ?? "").trim().toLowerCase();

// Per person: which halves of `date` (0 = first half, 1 = second half) are
// covered by a pending or approved leave request.
function coveredHalvesOn(
  date: string,
  requests: KekaLeaveRequest[],
  employees: { id: string; name?: string; email: string }[],
): Map<string, { name: string; covered: Set<number> }> {
  const byId = new Map(employees.map((e) => [e.id, e]));
  const halves = new Map<string, { name: string; covered: Set<number> }>();

  for (const request of requests) {
    if (
      !LEAVE_STATUSES.has(request.status) ||
      date < request.fromDate ||
      date > request.toDate
    ) {
      continue;
    }

    const employee = byId.get(request.employeeId);
    const email = employee ? normEmail(employee.email) : "";

    if (!employee || !email) {
      continue;
    }

    const first = date === request.fromDate ? request.fromSession : 0;
    const last = date === request.toDate ? request.toSession : 1;
    const entry = halves.get(email) ?? {
      name: String(employee.name ?? "").trim() || email,
      covered: new Set<number>(),
    };

    for (let half = first; half <= last; half++) {
      entry.covered.add(half);
    }

    halves.set(email, entry);
  }

  return halves;
}

// People on leave for the WHOLE day (both halves).
export function leavePeopleOn(
  date: string,
  requests: KekaLeaveRequest[],
  employees: { id: string; name?: string; email: string }[],
): LeavePerson[] {
  return [...coveredHalvesOn(date, requests, employees)]
    .filter(([, { covered }]) => covered.has(0) && covered.has(1))
    .map(([email, { name }]) => ({ email, name }));
}

// Emails on leave during one half of the day (0 = first half, 1 = second
// half), whether it is a half-day leave or part of a longer one.
export function leaveEmailsForHalf(
  date: string,
  half: number,
  requests: KekaLeaveRequest[],
  employees: { id: string; name?: string; email: string }[],
): Set<string> {
  return new Set(
    [...coveredHalvesOn(date, requests, employees)]
      .filter(([, { covered }]) => covered.has(half))
      .map(([email]) => email),
  );
}

// EVERYONE with leave on `date`, whole day or only one half, so each of
// them gets a leave message.
export function leaveAnnouncementsOn(
  date: string,
  requests: KekaLeaveRequest[],
  employees: { id: string; name?: string; email: string }[],
): LeavePerson[] {
  return [...coveredHalvesOn(date, requests, employees)]
    .filter(([, { covered }]) => covered.has(0) || covered.has(1))
    .map(([email, { name, covered }]) => ({
      email,
      name,
      part: covered.has(0) && covered.has(1) ? "full" : covered.has(0) ? "first" : "second",
    }));
}

export function leaveEmailsOn(
  date: string,
  requests: KekaLeaveRequest[],
  employees: { id: string; name?: string; email: string }[],
): Set<string> {
  return new Set(leavePeopleOn(date, requests, employees).map((p) => p.email));
}

// Monday–Friday. "YYYY-MM-DD".
export function isWorkingWeekday(ymd: string): boolean {
  const [y, m, d] = ymd.split("-").map(Number);
  const day = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();

  return day >= 1 && day <= 5;
}

export interface KekaLeaveReader {
  getActiveEmployees(): Promise<KekaEmployee[]>;
  getLeaveRequests(from: string, to: string): Promise<KekaLeaveRequest[]>;
}

export interface LeaveLookup {
  // THROWS when Keka cannot be read completely.
  getLeavePeople(date: string): Promise<LeavePerson[]>;
}

// Asks Keka at most once per `ttlMs` for a given day, so a watcher that polls
// every few seconds does not call Keka every time. If a refresh fails, the
// last good answer for the same day is kept; with none, it throws.
export class CachedLeaveLookup implements LeaveLookup {
  private cache: { date: string; at: number; people: LeavePerson[] } | null = null;

  constructor(
    private readonly client: KekaLeaveReader,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async getLeavePeople(date: string): Promise<LeavePerson[]> {
    const cached = this.cache;

    if (cached && cached.date === date && this.now() - cached.at < this.ttlMs) {
      return cached.people;
    }

    try {
      const [employees, requests] = await Promise.all([
        this.client.getActiveEmployees(),
        this.client.getLeaveRequests(date, date),
      ]);

      const people = leaveAnnouncementsOn(date, requests, employees);

      this.cache = { date, at: this.now(), people };

      return people;
    } catch (error) {
      if (cached && cached.date === date) {
        // Keep the last good answer; retry after the TTL.
        this.cache = { ...cached, at: this.now() };

        return cached.people;
      }

      throw error;
    }
  }
}

// null unless every Keka setting is present.
export function createCachedLeaveLookupFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LeaveLookup | null {
  const configured = [
    "KEKA_BASE_URL",
    "KEKA_CLIENT_ID",
    "KEKA_CLIENT_SECRET",
    "KEKA_API_KEY",
  ].every((name) => (env[name] ?? "").trim() !== "");

  return configured ? new CachedLeaveLookup(new KekaClient({ env })) : null;
}
