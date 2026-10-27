import "./config/loadEnv.js";

// Must run before the rest loads: reports missing settings clearly
// (and stops if the service cannot start without them).
import "./config/verifyStartupConfig.js";

import express from "express";

import {
  teamActivityWatcher,
  readTeamActivityWatcherConfig,
} from "./services/teamActivityWatcher.service.js";
import { goodMorningWatcher } from "./services/goodMorningWatcher.service.js";
import { readGoodMorningConfig } from "./config/runtimeConfig.js";
import { BUILD_ID, STARTED_AT } from "./config/build.js";
import { RestartFlagWatcher } from "./services/restartFlag.service.js";
import { createMissingTimesheetWatcherFromEnv } from "./services/missingTimesheetWatcher.service.js";
import { goodMorningImages } from "./services/goodMorningImages.service.js";

// Standalone Google Space service: Team Activity + Good Morning.
// Only a health check is served over HTTP (no AIOS / PMS routes).
const app = express();

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "intigate-google-space-team-activity",
    timestamp: new Date().toISOString(),
    // Which version is running, since when, and which Good Morning image
    // it will send (a public link) — visible without server access.
    build: BUILD_ID,
    startedAt: STARTED_AT,
    goodMorningImageUrl: process.env.GOOD_MORNING_IMAGE_URL ?? null,
    // Picture rotation: where the picture comes from, how many are left
    // this round, and which one is next.
    goodMorningImages: goodMorningImages.peek(),
    // Extra detail only; "status" stays "ok" while the service runs, so a
    // temporary Time Tracker / Google Chat outage is not reported as down.
    teamActivity: teamActivityWatcher.getStatus(),
    // Missing Timesheet: whether it is scheduled and which slots ran today.
    // Never includes the webhook.
    missingTimesheet: missingTimesheetWatcher
      ? missingTimesheetWatcher.getStatus()
      : { scheduled: false },
  });
});

// Missing Timesheet report. Built once; started in the listen callback
// below, and only when switched on and a safe destination exists (the
// testing Space by default, the main Space only when explicitly enabled).
const missingTimesheetWatcher = createMissingTimesheetWatcherFromEnv();

// Upload restart-now.txt into the state folder to restart without server
// access (run.cmd starts the service again). See restartFlag.service.ts.
const restartFlag = new RestartFlagWatcher({
  onRestart: () => shutdown("Restart requested"),
});

const port = Number(
  process.env.PORT ?? 4000,
);

const server = app.listen(port, (error?: Error) => {
  // Express 5 passes a bind failure (e.g. EADDRINUSE: another copy is
  // already running) to this callback. Do not start the watchers then,
  // or two copies would post every message twice.
  if (error) {
    console.error(
      `Cannot listen on port ${port}: ${error.message}. Is another copy of this service already running? Exiting.`,
    );
    process.exit(1);
  }

  console.log(
    `Google Space Team Activity service running on http://localhost:${port}`,
  );
  console.log(
    `Build ${BUILD_ID}, started ${STARTED_AT}. Good Morning image: ${process.env.GOOD_MORNING_IMAGE_URL ?? "(not set)"}`,
  );

  const pictures = goodMorningImages.peek();

  console.log(
    pictures.source === "list"
      ? `Good Morning pictures: rotation list in use, ${pictures.listed} in the list, ${pictures.sentThisRound} already sent this round, ${pictures.remainingThisRound} to go.`
      : pictures.source === "fallback"
        ? "Good Morning pictures: no list file, using the single GOOD_MORNING_IMAGE_URL."
        : "Good Morning pictures: no list file and no GOOD_MORNING_IMAGE_URL set.",
  );

  // Team Activity → Google Chat
  // Only ONE instance should run this watcher; set
  // TEAM_ACTIVITY_WATCHER_ENABLED=false on the others.
  // (Invalid values were already reported by the startup check.)
  const teamActivityConfig = readTeamActivityWatcherConfig();

  if (teamActivityConfig.enabled) {
    teamActivityWatcher.start(teamActivityConfig.intervalMs);
  } else {
    console.log(
      "Team Activity watcher is DISABLED on this instance (TEAM_ACTIVITY_WATCHER_ENABLED=false).",
    );
  }

  // Good Morning → same Google Chat Space
  // Like Team Activity, only ONE instance should send it; set
  // GOOD_MORNING_ENABLED=false on the others.
  if (readGoodMorningConfig().enabled) {
    goodMorningWatcher.start();
  } else {
    console.log(
      "Good Morning is DISABLED on this instance (GOOD_MORNING_ENABLED=false).",
    );
  }

  missingTimesheetWatcher?.start();

  restartFlag.start();
});

// On restart/shutdown, don't cut a Google Chat send in half (that is how a
// message ends up posted twice). Sending stops; anything not yet sent stays
// PENDING in the state file and goes out after the next start.
let shuttingDown = false;

function shutdown(reason: string): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`${reason}: finishing the current send, then stopping.`);

  restartFlag.stop();
  teamActivityWatcher.stop();
  goodMorningWatcher.stop();
  missingTimesheetWatcher?.stop();
  server.close();

  void teamActivityWatcher
    .waitForSendToFinish(20_000)
    .finally(() => process.exit(0));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => shutdown(`${signal} received`));
}
