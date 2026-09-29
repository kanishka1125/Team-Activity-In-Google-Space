# Team Activity in Google Space

A small Node.js + TypeScript service that watches a **Time Tracker** and posts to a **Google Chat Space**:

- **Team Activity**: who logged in, who switched project, who is on leave.
- **Good Morning**: a weekday message with a daily quote and image.

No database and no web pages. State is kept in small JSON files, so the service survives restarts without sending anything twice.

```
Time Tracker ──(every 15 s)──▶ Team Activity watcher ──▶ Google Chat Space
                                 │  detect → save PENDING → send → mark SENT
                                 ▼
                           state files (STATE_DIR)
                                 ▲
Good Morning (weekdays 9:30–10:00 IST) ── quote (AI or built-in) + image ──▶ Google Chat Space
```

## Example messages

```
🟢 Asha Rao has started working on Eureka at 9:26 AM 😄
🟢 Asha Rao switched to Li3ib from Eureka at 10:45 AM
🔴 Lina Shah is on leave today
```

## Features

- **No duplicates.** Every activity gets a stable ID and is saved as `PENDING` before it is sent, then marked `SENT` once Google Chat confirms.
- **Restart-safe.** `SENT` is never replayed, `PENDING` is delivered after a restart, and activity missed while the service was down is posted.
- **Retries with backoff.** Failed sends (429, 5xx, network, timeout) stay pending and retry after 5 s, 10 s, 20 s … up to 5 min. Nothing is dropped.
- **Time limits everywhere.** Time Tracker (30 s), Google Chat (15 s) and the AI call (60 s) can never hang the service.
- **Malformed rows are skipped, not fatal.** Unreadable rows are reported once and the valid rows keep working.
- **Good Morning quotes never repeat.** AI-written when configured (any OpenAI-compatible API), otherwise one of 50 built-in quotes.
- **Clean shutdown.** On Ctrl+C / SIGTERM it lets the message in flight finish, then exits.
- **Readable records.** `sent-entries.csv` and `skipped-entries.csv` open in Excel / Google Sheets.

## Quick start

Requires Node.js (tested on 22).

```bash
npm ci
cp .env.example .env      # then fill in the values
npm run build
npm start                 # or: npm run dev
```

Health check: `GET http://localhost:4000/health`

```json
{
  "status": "ok",
  "service": "…",
  "timestamp": "2026-09-29T11:22:05.614Z",
  "teamActivity": { "running": true, "checking": false, "lastCheckFinishedAt": "2026-09-29T11:22:01.213Z", "pending": 0 }
}
```

`status` stays `ok` while the service runs, so a temporary Time Tracker or Google Chat outage is not reported as down.

> **Run only ONE instance with the watchers enabled** (this includes any old backend that has the same feature). Two instances post every message twice. On any other instance set `TEAM_ACTIVITY_WATCHER_ENABLED=false` and `GOOD_MORNING_ENABLED=false`.

## Configuration

Copy `.env.example` to `.env`. Never commit `.env`.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TIME_TRACKER_API_URL` | yes | – | Time Tracker web app that returns all rows as JSON |
| `GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL` | yes | – | Incoming webhook of the Chat Space |
| `GOOD_MORNING_IMAGE_URL` | yes* | – | Public https image for Good Morning (*only if Good Morning is on) |
| `PORT` | no | `4000` | Health check port |
| `STATE_DIR` | no | start folder | Where all state files are kept |
| `TEAM_ACTIVITY_STATE_DIR` | no | `<STATE_DIR>/team-activity-state` | Overrides the Team Activity folder only |
| `TEAM_ACTIVITY_WATCHER_ENABLED` | no | `true` | Turn Team Activity off on an instance |
| `TEAM_ACTIVITY_POLL_INTERVAL_MS` | no | `15000` | Polling interval (minimum 5000) |
| `GOOD_MORNING_ENABLED` | no | `true` | Turn Good Morning off on an instance |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | no | – | AI quotes via an OpenAI-compatible API. Leave empty for built-in quotes. If a key is set without a URL, the URL defaults to a local Ollama (`localhost:11434`), so set `LLM_BASE_URL` explicitly for OpenAI. |

On start-up the service checks these and prints exactly what is missing and what will not work. Without `TIME_TRACKER_API_URL` it refuses to start.

## How it works

Full details are in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

1. **Read** all Time Tracker rows (gives up after 30 s).
2. **Check** rows. Unreadable dates/times are skipped with one warning per row.
3. **Detect** today's activity (India time): first entry = log-in, later entry on a new project = switch, leave row = leave.
4. **Record** new activity as `PENDING` in the state file *before* sending.
5. **Send** to Google Chat (about 1 per second). Success marks it `SENT`. Failure keeps it `PENDING` and retries.

Good Morning runs every 30 s, sends once per weekday between **9:30 and 10:00 IST**, and retries every minute if it fails. Keep the service running by 10:00 AM on weekdays.

## State files

Written to `STATE_DIR`. Keep this folder when redeploying so already-sent messages are never sent again.

| File | Content |
|---|---|
| `team-activity-state/activity-state.json` | Today's activities: `pending` / `sent` / `skipped` |
| `team-activity-state/sent-entries.csv` | Readable list of what was posted |
| `team-activity-state/skipped-entries.csv` | Readable list of what is waiting or was not posted |
| `.good-morning-state.json` | Last date Good Morning was sent |
| `.good-morning-quote-state.json` | Daily quotes, so they never repeat |

Files are written safely (temp file, then rename). An unreadable file is set aside as `…corrupt-<time>` instead of being overwritten. Team Activity files start fresh after midnight IST.

## Project layout

```
src/
  server.ts                            start-up, /health, clean shutdown
  config/                              settings and the start-up check
  services/
    teamActivity.service.ts            rows → activities
    teamActivityWatcher.service.ts     polling, dedupe, PENDING → SENT, retries
    teamActivityState.store.ts         state + CSV files, safe writes
    goodMorningWatcher.service.ts      weekday schedule and retry
    quote.service.ts, quoteLlm.ts      daily quote (AI or built-in)
    logThrottle.ts                     limits repeated error logs
  integrations/
    googleChat/                        webhook sender (text and card + image)
    timeTracker/                       Time Tracker client
test/                                  automated tests
scripts/resend-today.mjs               TEST ONLY: re-posts all of today's activity
```

## Tests

```bash
npm test
```

Covers detection, duplicates, restarts, retries and 429 handling, malformed data, time limits, quote history, the port-conflict check and clean shutdown (some tests start the real service as a separate process).

## Troubleshooting

| You see | Meaning |
|---|---|
| `Cannot listen on port 4000 … EADDRINUSE` | Another program uses the port. Set `PORT` to a free one. If that program is another copy of this service (or an old backend), also turn the watchers off on one of them. |
| `TIME_TRACKER_API_URL is missing` | Add it to `.env`. The service will not start without it. |
| `Google Chat send failed … kept as pending` | Nothing is lost. It retries automatically. |
| `could not read Time Tracker; will retry` | Time Tracker was slow or down. The next poll retries. |
| `skipped N Time Tracker row(s) with an unreadable date/time` | Those rows are ignored. Check the Time Tracker data. |
| `interrupted by a restart; it will be resent` | The service was killed mid-send. That one message may appear twice. |

## Notes

- Google Chat has no way to prevent a duplicate if the service is killed at the exact moment of a send, so a very rare repeat is possible after a hard crash. A normal Ctrl+C / SIGTERM avoids it.
- There is no holiday calendar. Good Morning is sent every weekday.
