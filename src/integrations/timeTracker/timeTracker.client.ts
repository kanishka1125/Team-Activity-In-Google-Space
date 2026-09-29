import type { RawTimeTrackerEntry } from "./timeTracker.types.js";

// How long to wait for the Time Tracker to answer. Without a limit,
// Node waits up to 5 minutes for a stuck request, and the Team
// Activity watcher can't poll again until it gives up.
export const TIME_TRACKER_TIMEOUT_MS = 30_000;

export class TimeTrackerClient {
  private readonly apiUrl: string;

  private readonly timeoutMs: number;

  constructor(timeoutMs = TIME_TRACKER_TIMEOUT_MS) {
    const apiUrl = process.env.TIME_TRACKER_API_URL;

    if (!apiUrl) {
      throw new Error("TIME_TRACKER_API_URL is not configured");
    }

    this.apiUrl = apiUrl;
    this.timeoutMs = timeoutMs;
  }

  async getData(): Promise<RawTimeTrackerEntry[]> {
    let response: Response;

    try {
      response = await fetch(this.apiUrl, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        throw new Error(
          `Time Tracker API request failed: ${response.status} ${response.statusText}`,
        );
      }

      const data: unknown = await response.json();

      // An error page or {error: ...} body with HTTP 200 would otherwise
      // fail later with an unclear "not iterable" error.
      if (!Array.isArray(data)) {
        throw new Error(
          "Time Tracker API returned an unexpected response (expected a list of rows)",
        );
      }

      return data as RawTimeTrackerEntry[];
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TimeoutError"
      ) {
        throw new Error(
          `Time Tracker API did not respond within ${Math.round(this.timeoutMs / 1000)} seconds`,
        );
      }

      throw error;
    }
  }
}
