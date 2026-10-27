import {
  normaliseEmail,
  readUnallocatedConfig,
  type UnallocatedConfig,
} from "../config/runtimeConfig.js";
import { KekaClient, type KekaEmployee } from "../integrations/keka/keka.client.js";
import { PmsTasksClient } from "../integrations/pms/pms.client.js";
import type { PmsTask } from "../integrations/pms/pms.types.js";
import {
  OPEN_STATUSES,
  TERMINAL_STATUSES,
  parsePmsDueDate,
} from "../integrations/pms/pmsRules.js";
import type { TeamActivityEvent } from "./teamActivity.service.js";

// ---------------------------------------------------------------
// Unallocated resources (daily ~12 PM, Team Activity space only)
//
//   employee (Keka, status Working)
//     − approved exclusions (founders / leadership, by email)
//     − on leave today (Time Tracker leave rows, by email)
//     − has a qualifying PMS task
//     = unallocated
//
// Qualifying PMS task: assigned to the employee's email, status OPEN,
// due date today or later (India date). A task counts when the task
// itself, or one of its subtasks, qualifies on its own assignee /
// status / due date.
//
// This file only DECIDES. Sending, PENDING/SENT state and retries are
// done by the existing Team Activity watcher.
// ---------------------------------------------------------------

// Kept exported from here so existing imports keep working.
export { parsePmsDueDate };

export const UNALLOCATED_HEADER = "🟡 Unallocated resources for today:";

export interface UnallocatedInput {
  employees: KekaEmployee[];
  tasks: PmsTask[];
  leaveEmails: Set<string>;
  excludedEmails: Set<string>;
  // other email → Keka email (same person, different address).
  emailAliases?: Record<string, string>;
  // India date, "YYYY-MM-DD".
  today: string;
}

export interface UnallocatedResult {
  unallocated: KekaEmployee[];
  unknownStatuses: string[];
  counts: {
    employees: number;
    excluded: number;
    onLeave: number;
    allocated: number;
    unallocated: number;
  };
}

export function computeUnallocated(
  input: UnallocatedInput,
): UnallocatedResult {
  const unknownStatuses = new Set<string>();
  const aliases = input.emailAliases ?? {};

  // Same person, one key: an explicitly configured alias maps the
  // Time Tracker / PMS address to the one Keka has.
  const canonical = (value: unknown): string => {
    const email = normaliseEmail(value);

    return aliases[email] ?? email;
  };

  const qualifies = (
    assignee: unknown,
    status: unknown,
    dueDate: unknown,
  ): string | null => {
    const email = canonical(assignee);

    if (!email) {
      return null;
    }

    const statusName = String(status ?? "").trim().toLowerCase();

    if (TERMINAL_STATUSES.has(statusName)) {
      return null;
    }

    if (!OPEN_STATUSES.has(statusName)) {
      unknownStatuses.add(String(status ?? "").trim() || "(empty)");
      return null;
    }

    const due = parsePmsDueDate(dueDate);

    if (!due || due < input.today) {
      return null;
    }

    return email;
  };

  const allocatedEmails = new Set<string>();

  for (const task of input.tasks) {
    const own = qualifies(task.assignee, task.status, task.dueDate);

    if (own) {
      allocatedEmails.add(own);
    }

    for (const sub of task.subs ?? []) {
      const subEmail = qualifies(sub?.assignee, sub?.status, sub?.dueDate);

      if (subEmail) {
        allocatedEmails.add(subEmail);
      }
    }
  }

  const leaveKeys = new Set(
    [...input.leaveEmails].map((value) => canonical(value)),
  );

  let excluded = 0;
  let onLeave = 0;
  let allocated = 0;
  const unallocated: KekaEmployee[] = [];

  for (const employee of input.employees) {
    const email = normaliseEmail(employee.email);

    if (input.excludedEmails.has(email)) {
      excluded++;
    } else if (leaveKeys.has(email)) {
      onLeave++;
    } else if (allocatedEmails.has(email)) {
      allocated++;
    } else {
      unallocated.push(employee);
    }
  }

  unallocated.sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  );

  return {
    unallocated,
    unknownStatuses: [...unknownStatuses].sort(),
    counts: {
      employees: input.employees.length,
      excluded,
      onLeave,
      allocated,
      unallocated: unallocated.length,
    },
  };
}

export function buildUnallocatedMessage(
  employees: KekaEmployee[],
): string {
  return `${UNALLOCATED_HEADER}\n\n${employees
    .map((employee) => employee.name)
    .join("\n")}`;
}

// Emails of people on leave today, from the Time Tracker activity the
// watcher has just fetched (same leave detection as the leave
// notifications; nothing is re-detected here).
export function leaveEmailsToday(
  activities: TeamActivityEvent[],
  today: string,
): Set<string> {
  const result = new Set<string>();

  for (const activity of activities) {
    if (activity.type !== "leave") {
      continue;
    }

    // "DD-MM-YYYY" → "YYYY-MM-DD"
    const [d, m, y] = (activity.dateSubmitted ?? "").split("-");

    if (`${y}-${m}-${d}` === today) {
      result.add(normaliseEmail(activity.email));
    }
  }

  return result;
}

export interface EmployeeSource {
  getActiveEmployees(): Promise<KekaEmployee[]>;
}

export interface TaskSource {
  getTasks(): Promise<PmsTask[]>;
}

export interface UnallocatedJobOptions {
  config: UnallocatedConfig;
  employees: EmployeeSource;
  tasks: TaskSource;
}

export class UnallocatedResourcesJob {
  readonly checkMinutes: number;

  readonly latestMinutes: number;

  private readonly employees: EmployeeSource;

  private readonly tasks: TaskSource;

  private readonly excluded: Set<string>;

  private readonly aliases: Record<string, string>;

  constructor(options: UnallocatedJobOptions) {
    this.checkMinutes = options.config.checkHour * 60;
    // Up to and including the whole "latest" hour.
    this.latestMinutes = options.config.latestHour * 60 + 59;
    this.employees = options.employees;
    this.tasks = options.tasks;
    this.excluded = new Set(options.config.excludedEmails);
    this.aliases = options.config.emailAliases;
  }

  // Returns the message to send, or null when nobody is unallocated.
  // THROWS if Keka or PMS cannot be read completely: the caller sends
  // nothing and tries again later.
  async evaluate(
    activities: TeamActivityEvent[],
    today: string,
  ): Promise<string | null> {
    const employees = await this.employees.getActiveEmployees();
    const tasks = await this.tasks.getTasks();

    const result = computeUnallocated({
      employees,
      tasks,
      leaveEmails: leaveEmailsToday(activities, today),
      excludedEmails: this.excluded,
      emailAliases: this.aliases,
      today,
    });

    if (result.unknownStatuses.length > 0) {
      console.warn(
        `Unallocated resources: PMS task status value(s) not recognised as open or finished (treated as not allocated): ${result.unknownStatuses.join(", ")}.`,
      );
    }

    const c = result.counts;

    console.log(
      `Unallocated resources check: ${c.employees} working employees, ${c.excluded} excluded, ${c.onLeave} on leave, ${c.allocated} allocated, ${c.unallocated} unallocated.`,
    );

    if (result.unallocated.length === 0) {
      return null;
    }

    return buildUnallocatedMessage(result.unallocated);
  }
}

// One log line saying whether the report is on (start-up log).
export function describeUnallocatedConfig(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const config = readUnallocatedConfig(env);

  if (!config.enabled) {
    return `Unallocated resources report is OFF: ${config.reason}.`;
  }

  return `Unallocated resources report is ON: runs from ${String(config.checkHour).padStart(2, "0")}:00 India time (not after ${String(config.latestHour).padStart(2, "0")}:59), ${config.excludedEmails.length} email(s) excluded, ${Object.keys(config.emailAliases).length} alias(es).`;
}

// Returns the job when every Keka / PMS setting is present, otherwise
// null (the report is simply off and everything else is unchanged).
export function createUnallocatedJobFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): UnallocatedResourcesJob | null {
  const config = readUnallocatedConfig(env);

  if (!config.enabled) {
    return null;
  }

  return new UnallocatedResourcesJob({
    config,
    employees: new KekaClient({ env }),
    tasks: new PmsTasksClient({ env }),
  });
}
