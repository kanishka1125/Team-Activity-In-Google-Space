import "dotenv/config";

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

// Standalone Google Space service: Team Activity + Good Morning.
// Only a health check is served over HTTP (no AIOS / PMS routes).
const app = express();

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "intigate-google-space-team-activity",
    timestamp: new Date().toISOString(),
    // Extra detail only; "status" stays "ok" while the service runs, so a
    // temporary Time Tracker / Google Chat outage is not reported as down.
    teamActivity: teamActivityWatcher.getStatus(),
  });
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
});

// On restart/shutdown, don't cut a Google Chat send in half (that is how a
// message ends up posted twice). Sending stops; anything not yet sent stays
// PENDING in the state file and goes out after the next start.
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    console.log(`${signal} received: finishing the current send, then stopping.`);

    teamActivityWatcher.stop();
    goodMorningWatcher.stop();
    server.close();

    void teamActivityWatcher
      .waitForSendToFinish(20_000)
      .finally(() => process.exit(0));
  });
}
