import dotenv from "dotenv";

// Loads this folder's .env — and makes it WIN over a setting of the same
// name that already exists on the machine (Windows environment variable).
//
// `dotenv/config` never replaces an existing machine setting, so a
// leftover GOOD_MORNING_IMAGE_URL (or webhook, etc.) set on the server
// silently beat the .env file, and edits to .env seemed to do nothing.
//
// Names (never values) of any replaced settings are logged.
const before = { ...process.env };

const result = dotenv.config({ override: true });

const replaced = Object.entries(result.parsed ?? {})
  .filter(([name, value]) => before[name] !== undefined && before[name] !== value)
  .map(([name]) => name);

if (replaced.length > 0) {
  console.warn(
    `Settings found on this machine were replaced by the values in .env: ${replaced.join(", ")}.`,
  );
}
