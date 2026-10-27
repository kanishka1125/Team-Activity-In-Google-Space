// ---------------------------------------------------------------
// Missing Timesheet report: settings and destination safety.
//
// WHERE it posts is always an explicit choice:
//
//   default (testing)
//     MISSING_TIMESHEET_WEBHOOK_URL    incoming-webhook URL of a dedicated
//                                      testing Space. The main Space's
//                                      webhook is refused.
//   main Space (approved)
//     MISSING_TIMESHEET_POST_TO_MAIN_SPACE=true
//                                      post to the MAIN Space, using
//                                      GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL.
//                                      Only this exact setting turns it on;
//                                      MISSING_TIMESHEET_WEBHOOK_URL is then
//                                      ignored.
//
//   MISSING_TIMESHEET_EXPECTED_SPACE_ID optional extra check: the Space id
//                                    (the part after /spaces/ in the
//                                    webhook URL) the chosen destination
//                                    MUST belong to.
//   MISSING_TIMESHEET_SCHEDULE_ENABLED  true | false (default false). The
//                                    weekday schedule only runs when this
//                                    is true. Dry runs and manual test
//                                    sends never need it.
//   MISSING_TIMESHEET_SEND_TIMES        India times (24-hour HH:MM, comma
//                                    separated) of the daily sends.
//                                    Default 12:00,15:00.
//   MISSING_TIMESHEET_EXCLUDED_EMAILS   comma-separated emails that are ALWAYS
//                                    left out of the list (approved
//                                    leadership). Matched by email.
//
// Safety:
//   - in the default (testing) mode the destination has its own webhook
//     setting and NEVER falls back to GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL,
//     and a webhook that belongs to the same Space as the main one is
//     refused, even if the key/token differ;
//   - the main Space is used only when MISSING_TIMESHEET_POST_TO_MAIN_SPACE is
//     exactly true, and then only its own webhook;
//   - any problem means "no destination": nothing is sent anywhere.
//
// This module imports nothing else from the app. Secrets (webhook key
// and token) are never returned by describeMissingTimesheetConfig().
// ---------------------------------------------------------------

import { parseBooleanSetting } from "./runtimeConfig.js";

// Schedule: Monday–Friday, India Standard Time.
export const MISSING_TIMESHEET_TIME_ZONE = "Asia/Kolkata";

// If the first attempt of a slot fails (Time Tracker down, Google Chat error,
// restart on the hour) keep trying this long, then give up for that slot.
export const MISSING_TIMESHEET_WINDOW_MINUTES = 30;

export const DEFAULT_MISSING_TIMESHEET_SEND_TIMES = "12:00,15:00";

const MAX_SEND_TIMES = 6;

export interface SendTime {
  hour: number;
  minute: number;
  // "12:00" (24-hour, used as the key in the state file)
  key: string;
  // "12:00 PM" (shown in the message header)
  label: string;
}

// 15, 0 → "3:00 PM"
export function formatTimeLabel(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;

  return `${twelve}:${String(minute).padStart(2, "0")} ${period}`;
}

function toSendTime(hour: number, minute: number): SendTime {
  return {
    hour,
    minute,
    key: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    label: formatTimeLabel(hour, minute),
  };
}

// "12:00, 15:00" → sorted, valid, de-duplicated slots. Anything invalid
// is dropped with a warning; if nothing valid is left the default is used.
export function parseSendTimes(
  value: string | undefined,
  warnings: string[] = [],
): SendTime[] {
  const raw = (value ?? "").trim();

  const parse = (text: string): SendTime[] => {
    const result: SendTime[] = [];

    for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
      const match = /^(\d{1,2}):(\d{2})$/.exec(part);
      const hour = match ? Number(match[1]) : NaN;
      const minute = match ? Number(match[2]) : NaN;

      if (!match || hour > 23 || minute > 59) {
        warnings.push(
          `MISSING_TIMESHEET_SEND_TIMES entry "${part}" is not a 24-hour HH:MM time; it was ignored.`,
        );
        continue;
      }

      const slot = toSendTime(hour, minute);

      if (!result.some((existing) => existing.key === slot.key)) {
        result.push(slot);
      }
    }

    result.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));

    return result;
  };

  let slots = parse(raw || DEFAULT_MISSING_TIMESHEET_SEND_TIMES);

  // Each slot has its own retry window, so slots must not overlap.
  const spaced: SendTime[] = [];

  for (const slot of slots) {
    const previous = spaced[spaced.length - 1];

    if (
      previous &&
      slot.hour * 60 + slot.minute - (previous.hour * 60 + previous.minute) <
        MISSING_TIMESHEET_WINDOW_MINUTES
    ) {
      warnings.push(
        `MISSING_TIMESHEET_SEND_TIMES: ${slot.key} is less than ${MISSING_TIMESHEET_WINDOW_MINUTES} minutes after ${previous.key}; it was ignored.`,
      );
      continue;
    }

    spaced.push(slot);
  }

  slots = spaced;

  if (slots.length > MAX_SEND_TIMES) {
    warnings.push(
      `MISSING_TIMESHEET_SEND_TIMES has more than ${MAX_SEND_TIMES} times; only the first ${MAX_SEND_TIMES} are used.`,
    );
    slots = slots.slice(0, MAX_SEND_TIMES);
  }

  if (slots.length === 0) {
    warnings.push(
      `MISSING_TIMESHEET_SEND_TIMES has no valid time; using the default (${DEFAULT_MISSING_TIMESHEET_SEND_TIMES}).`,
    );

    return parse(DEFAULT_MISSING_TIMESHEET_SEND_TIMES);
  }

  return slots;
}

const EMAIL_PATTERN = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;

// "a@x.com, B@x.com" → ["a@x.com", "b@x.com"]
export function parseExcludedEmails(
  value: string | undefined,
  warnings: string[] = [],
): string[] {
  const result: string[] = [];

  for (const part of (value ?? "")
    .split(/[,;\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)) {
    if (!EMAIL_PATTERN.test(part)) {
      warnings.push(
        "MISSING_TIMESHEET_EXCLUDED_EMAILS has an entry that is not an email address; it was ignored.",
      );
      continue;
    }

    if (!result.includes(part)) {
      result.push(part);
    }
  }

  return result;
}

// "https://chat.googleapis.com/v1/spaces/AAQA…/messages?key=…&token=…"
// → "AAQA…", or null when it is not a Google Chat webhook URL.
export function extractSpaceId(webhookUrl: string): string | null {
  let url: URL;

  try {
    url = new URL(webhookUrl.trim());
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || url.hostname !== "chat.googleapis.com") {
    return null;
  }

  const match = /^\/v1\/spaces\/([^/]+)\/messages\/?$/.exec(url.pathname);

  return match?.[1] ?? null;
}

export interface MissingTimesheetDestination {
  webhookUrl: string;
  spaceId: string;
  // "testing" = the dedicated testing Space, "main" = the main Space.
  kind: "testing" | "main";
}

export interface MissingTimesheetConfig {
  scheduleEnabled: boolean;
  sendTimes: SendTime[];
  excludedEmails: string[];
  // null whenever the destination is missing or unsafe.
  destination: MissingTimesheetDestination | null;
  // Why there is no usable destination (setting names only).
  problems: string[];
  warnings: string[];
}

export function readMissingTimesheetConfig(
  env: NodeJS.ProcessEnv = process.env,
): MissingTimesheetConfig {
  const problems: string[] = [];
  const warnings: string[] = [];

  let scheduleEnabled =
    parseBooleanSetting(env.MISSING_TIMESHEET_SCHEDULE_ENABLED, false);

  if (scheduleEnabled === undefined) {
    warnings.push(
      `MISSING_TIMESHEET_SCHEDULE_ENABLED="${env.MISSING_TIMESHEET_SCHEDULE_ENABLED}" is not true/false; using the default (off).`,
    );
    scheduleEnabled = false;
  }

  const sendTimes = parseSendTimes(env.MISSING_TIMESHEET_SEND_TIMES, warnings);
  const excludedEmails = parseExcludedEmails(
    env.MISSING_TIMESHEET_EXCLUDED_EMAILS,
    warnings,
  );

  const mainWebhook = (env.GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL ?? "").trim();
  const expected = (env.MISSING_TIMESHEET_EXPECTED_SPACE_ID ?? "").trim();

  let postToMain = parseBooleanSetting(env.MISSING_TIMESHEET_POST_TO_MAIN_SPACE, false);

  if (postToMain === undefined) {
    // Anything that is not clearly true/false must never switch the main
    // Space on.
    warnings.push(
      `MISSING_TIMESHEET_POST_TO_MAIN_SPACE="${env.MISSING_TIMESHEET_POST_TO_MAIN_SPACE}" is not true/false; using the default (testing Space only).`,
    );
    postToMain = false;
  }

  let destination: MissingTimesheetDestination | null = null;

  if (postToMain) {
    // Explicitly approved: the MAIN Space, with its own webhook only.
    const spaceId = mainWebhook ? extractSpaceId(mainWebhook) : null;

    if (!mainWebhook) {
      problems.push(
        "MISSING_TIMESHEET_POST_TO_MAIN_SPACE is true but GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL is not set.",
      );
    } else if (!spaceId) {
      problems.push(
        "GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL is not a Google Chat webhook URL (https://chat.googleapis.com/v1/spaces/…/messages?…).",
      );
    } else if (expected && expected !== spaceId) {
      problems.push(
        "The main Space's webhook does not belong to the Space named in MISSING_TIMESHEET_EXPECTED_SPACE_ID. Refusing to use it.",
      );
    } else {
      destination = { webhookUrl: mainWebhook, spaceId, kind: "main" };
    }
  } else {
    const webhookUrl = (env.MISSING_TIMESHEET_WEBHOOK_URL ?? "").trim();

    if (!webhookUrl) {
      problems.push(
        "MISSING_TIMESHEET_WEBHOOK_URL is not set (the testing Space's webhook; the main Space is never used instead).",
      );
    } else {
      const spaceId = extractSpaceId(webhookUrl);

      if (!spaceId) {
        problems.push(
          "MISSING_TIMESHEET_WEBHOOK_URL is not a Google Chat webhook URL (https://chat.googleapis.com/v1/spaces/…/messages?…).",
        );
      } else if (
        webhookUrl === mainWebhook ||
        (mainWebhook && extractSpaceId(mainWebhook) === spaceId)
      ) {
        problems.push(
          "MISSING_TIMESHEET_WEBHOOK_URL points at the MAIN Space (same Space as GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL). Refusing to use it: create a separate testing Space, or set MISSING_TIMESHEET_POST_TO_MAIN_SPACE=true if posting to the main Space is intended.",
        );
      } else if (expected && expected !== spaceId) {
        problems.push(
          "MISSING_TIMESHEET_WEBHOOK_URL does not belong to the Space named in MISSING_TIMESHEET_EXPECTED_SPACE_ID. Refusing to use it.",
        );
      } else {
        destination = { webhookUrl, spaceId, kind: "testing" };
      }
    }
  }

  if (!expected && destination) {
    warnings.push(
      destination.kind === "main"
        ? "MISSING_TIMESHEET_EXPECTED_SPACE_ID is not set: the MAIN Space is used without a Space-id check. Setting it to the main Space's id guards against a wrong webhook."
        : "MISSING_TIMESHEET_EXPECTED_SPACE_ID is not set: only 'not the main Space' is checked. Setting it to the testing Space's id also proves the webhook belongs to that Space.",
    );
  }

  if (excludedEmails.length === 0) {
    warnings.push(
      "MISSING_TIMESHEET_EXCLUDED_EMAILS is empty: nobody is excluded from the list.",
    );
  }

  return {
    scheduleEnabled,
    sendTimes,
    excludedEmails,
    destination,
    problems,
    warnings,
  };
}

// One start-up log line. No webhook URL, key or token: only whether a
// safe destination exists and a shortened Space id.
export function describeMissingTimesheetConfig(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const config = readMissingTimesheetConfig(env);

  if (!config.scheduleEnabled) {
    return "Missing Timesheet report: schedule OFF (MISSING_TIMESHEET_SCHEDULE_ENABLED is not true). Dry run and manual test send remain available.";
  }

  if (!config.destination) {
    return `Missing Timesheet report: schedule OFF, no safe destination: ${config.problems.join(" ")}`;
  }

  const where =
    config.destination.kind === "main"
      ? `the MAIN Space ${config.destination.spaceId.slice(0, 4)}… (MISSING_TIMESHEET_POST_TO_MAIN_SPACE=true)`
      : `the testing Space ${config.destination.spaceId.slice(0, 4)}… (not the main Space)`;

  return `Missing Timesheet report: schedule ON, weekdays at ${config.sendTimes.map((t) => t.label).join(", ")} ${MISSING_TIMESHEET_TIME_ZONE}, ${config.excludedEmails.length} email(s) always excluded, posting to ${where}.`;
}
