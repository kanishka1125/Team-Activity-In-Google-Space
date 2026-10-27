// Missing Timesheet — manual tool.
//
//   npm run missing-timesheet:dry-run     read the Time Tracker, print the
//                                         message, SEND NOTHING
//   npm run missing-timesheet:send-test   same, then post ONE message to the
//                                         configured Space (header shows the
//                                         actual current India time)
//
// Safety:
//   - Dry run is the default. Sending needs the explicit --send-test flag.
//   - It only ever sends to the destination the scheduler would use, and only
//     if that passes the same checks: by default the testing Space
//     (MISSING_TIMESHEET_WEBHOOK_URL, never the main Space). Only when
//     MISSING_TIMESHEET_POST_TO_MAIN_SPACE=true is the destination the MAIN
//     Space, and then a manual send also needs --confirm-main-space.
//   - Like the schedule, it sends nothing when nobody is missing, or when the
//     Time Tracker has no row at all for today.
//   - A manual send does not touch the schedule's state file, so it neither
//     triggers nor blocks any scheduled message.
//   - If the Time Tracker cannot be read, nothing is sent.
//   - The webhook URL / key / token are never printed.
//
// Uses the compiled code in dist/ (the npm scripts run the build first).
import "../dist/config/loadEnv.js";

import { readMissingTimesheetConfig } from "../dist/config/missingTimesheetConfig.js";
import { googleChatService } from "../dist/integrations/googleChat/googleChat.service.js";
import { createMissingTimesheetReporterFromEnv } from "../dist/services/missingTimesheet.service.js";

const sendTest = process.argv.includes("--send-test");

const config = readMissingTimesheetConfig();

if (sendTest && !config.destination) {
  console.error("NOT SENDING: there is no safe destination configured.");
  for (const problem of config.problems) {
    console.error(`  - ${problem}`);
  }
  console.error(
    "Fix the setting named above (see README, 'Missing Timesheet'). With MISSING_TIMESHEET_POST_TO_MAIN_SPACE=true the main Space's webhook must be set; otherwise set MISSING_TIMESHEET_WEBHOOK_URL to the testing Space's webhook.",
  );
  process.exit(1);
}

// A manual send to the MAIN Space needs a second, explicit flag.
if (sendTest && config.destination.kind === "main" && !process.argv.includes("--confirm-main-space")) {
  console.error(
    "NOT SENDING: the destination is the MAIN Space (MISSING_TIMESHEET_POST_TO_MAIN_SPACE=true). To post one manual message there, run: node scripts/missing-timesheet.mjs --send-test --confirm-main-space",
  );
  process.exit(1);
}

let report;

try {
  report = await createMissingTimesheetReporterFromEnv().buildReport();
} catch (error) {
  console.error(
    `Time Tracker data could not be used, so NO list was built and nothing was sent: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

const c = report.result.counts;

console.log(
  `Time Tracker: ${c.rows} rows (${c.ignoredRows} unreadable), ${c.rowsToday} dated today, ${c.onLeaveToday} on leave today | ${c.people} people expected to log, ${c.excluded} always excluded, MISSING ${c.missing}`,
);

if (report.message === null) {
  console.log(
    report.reason === "no_data_today"
      ? "\nThe Time Tracker has no row at all for today (holiday, or it is not updating): NO message would be sent."
      : "\nNobody is missing a timesheet: NO message would be sent.",
  );
  process.exit(0);
}

console.log("---------------- message preview ----------------");
console.log(report.message);
console.log("-------------------------------------------------");

if (!sendTest) {
  console.log("\nDRY RUN: nothing was sent.");
  process.exit(0);
}

console.log(
  `\nSending ONE message to the ${config.destination.kind === "main" ? "MAIN" : "testing"} Space ${config.destination.spaceId.slice(0, 4)}…`,
);

try {
  await googleChatService.sendMissingTimesheetMessage(
    config.destination.webhookUrl,
    report.message,
  );
  console.log("Sent. Check the Space.");
} catch (error) {
  console.error(
    `Send failed: ${error instanceof Error ? error.message.replace(/key=[^&\s]+|token=[^&\s]+/g, "[hidden]") : String(error)}`,
  );
  process.exit(3);
}
