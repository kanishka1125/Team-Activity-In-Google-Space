// Imported by server.ts BEFORE the rest of the app, so problems are
// reported clearly before any service tries to use a missing setting.
import {
  checkStartupConfig,
  formatStartupReport,
} from "./startupCheck.js";

const result = checkStartupConfig();
const lines = formatStartupReport(result);

if (lines.length === 0) {
  console.log("Startup configuration check: OK.");
} else if (result.blocking.length > 0) {
  console.error(
    [
      "Startup configuration check FAILED — the backend was NOT started:",
      ...lines,
      "Add the missing settings to this folder's .env file and start again.",
    ].join("\n"),
  );

  process.exit(1);
} else {
  const hasErrors =
    result.missing.length > 0 || result.problems.length > 0;

  (hasErrors ? console.error : console.warn)(
    [
      hasErrors
        ? "Startup configuration check: the backend is starting, but some features will not work:"
        : "Startup configuration check: OK, with notes:",
      ...lines,
    ].join("\n"),
  );
}
