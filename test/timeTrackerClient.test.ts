import http from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  TimeTrackerClient,
  TIME_TRACKER_TIMEOUT_MS,
} from "../src/integrations/timeTracker/timeTracker.client.js";

let server: http.Server;
let base = "";
const stuck: http.ServerResponse[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/hang") {
      stuck.push(res); // never answers
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([{ rowIndex: 2, name: "Asha" }]));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  stuck.forEach((r) => r.destroy());
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

describe("Time Tracker request time limit", () => {
  it("default limit is 30 seconds", () => {
    expect(TIME_TRACKER_TIMEOUT_MS).toBe(30_000);
  });

  it("normal responses work as before", async () => {
    process.env.TIME_TRACKER_API_URL = `${base}/ok`;
    await expect(new TimeTrackerClient().getData()).resolves.toEqual([{ rowIndex: 2, name: "Asha" }]);
  });

  it("a stuck request gives up after the limit with a clear error", async () => {
    process.env.TIME_TRACKER_API_URL = `${base}/hang`;
    const started = Date.now();
    await expect(new TimeTrackerClient(300).getData()).rejects.toThrow(
      "Time Tracker API did not respond within 0 seconds",
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
