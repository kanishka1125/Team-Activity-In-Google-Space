// TEMPORARY TEST HELPER — marks ALL of today's Team Activity records as
// "pending", so the next `npm start` posts every one of them (including
// ones already sent or skipped) to the configured Google Chat Space.
//
// Use only to check the service end-to-end (e.g. with a test space).
// 1. Stop the service first (Ctrl+C) — a running service would overwrite this.
// 2. npm run resend-today
// 3. npm start
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const stateDir = path.resolve(
  process.env.TEAM_ACTIVITY_STATE_DIR?.trim() ||
    path.join(process.env.STATE_DIR?.trim() || process.cwd(), "team-activity-state"),
);

const parts = Object.fromEntries(
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(new Date())
    .map((p) => [p.type, p.value]),
);
const today = `${parts.year}-${parts.month}-${parts.day}`;
const file = path.join(stateDir, "activity-state.json");

if (!fs.existsSync(file)) {
  console.error(`No state file: ${file} (start the service once first)`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(file, "utf-8"));
const records = data?.days?.[today];

if (!Array.isArray(records)) {
  console.error(`No activities recorded for ${today} yet.`);
  process.exit(1);
}

const before = {};

for (const record of records) {
  before[record.status] = (before[record.status] ?? 0) + 1;
  record.status = "pending";
  record.attempts = 0;
  record.lastError = null;
  record.nextAttemptAt = null;
  record.sendStartedAt = null;
  record.sentAt = null;
}

// Safe write: temp file, then rename.
const temp = `${file}.resend.tmp`;
fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf-8");
fs.renameSync(temp, file);

console.log(
  `Marked ${records.length} activities for ${today} as pending (were: ${JSON.stringify(before)}).`,
);
console.log(
  `Webhook: Google Chat space ${new URL(process.env.GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL ?? "https://x/none").pathname.split("/")[3] ?? "?"}`,
);
console.log("Now run: npm start   (they are posted about 1 per second)");
