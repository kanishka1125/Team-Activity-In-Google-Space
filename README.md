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
| `KEKA_BASE_URL`, `KEKA_CLIENT_ID`, `KEKA_CLIENT_SECRET`, `KEKA_API_KEY` | no* | – | Keka (read-only) employee list for the 12 PM unallocated report (*all six Keka/PMS settings are needed to turn the report on) |
| `KEKA_AUTH_URL` | no | `https://login.keka.com/connect/token` | Keka sign-in address |
| `PMS_TASKS_API_URL`, `PMS_API_KEY` | no* | – | PMS tasks (read-only) for the unallocated report |
| `UNALLOCATED_ENABLED` | no | `true` | Turn the unallocated report off |
| `UNALLOCATED_CHECK_HOUR` / `UNALLOCATED_LATEST_HOUR` | no | `12` / `15` | India-time hour it starts, and the last hour it may still be sent |
| `UNALLOCATED_EXCLUDED_EMAILS` | no | – | Comma-separated emails never listed (approved founders / leadership) |
| `UNALLOCATED_EMAIL_ALIASES` | no | – | `other@x=keka@x,…` when a person's Time Tracker / PMS email differs from Keka's |
| `MISSING_TIMESHEET_POST_TO_MAIN_SPACE` | no | `false` | `true` = post the Missing Timesheet report to the **main** Space (using `GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL`). Off = it posts only to a testing Space. Nothing else can switch the main Space on |
| `MISSING_TIMESHEET_WEBHOOK_URL` | testing mode | – | Incoming webhook of a dedicated testing Space (used when `MISSING_TIMESHEET_POST_TO_MAIN_SPACE` is not true). In this mode the main Space is refused and there is no fallback to it |
| `MISSING_TIMESHEET_EXPECTED_SPACE_ID` | no | – | Extra safety: the id of the Space the chosen destination MUST belong to (the part after `/spaces/` in its webhook). Refused if it differs |
| `MISSING_TIMESHEET_SCHEDULE_ENABLED` | no | `false` | Turn on the weekday schedule. Dry run and manual test send do not need it |
| `MISSING_TIMESHEET_SEND_TIMES` | no | `12:00,15:00` | India times (24-hour `HH:MM`, comma separated) of the weekday checks. At least 30 minutes apart |
| `MISSING_TIMESHEET_EXCLUDED_EMAILS` | no | – | Comma-separated emails that are ALWAYS left out of the list (approved leadership) |
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

## Unallocated resources (12 PM)

Once a day from **12:00 India time** (not after 15:59) the service posts to the Team Activity space:

```
🟡 Unallocated resources for today:

Name one
Name two
```

Who is listed: every **Working** employee in **Keka** (read-only, loaded fresh each day, nothing hard-coded) **minus** the approved exclusions, **minus** people on leave today (Time Tracker leave rows), **minus** people with a qualifying **PMS** task. A qualifying task is assigned to the person's email, has status `Backlog`, `To Do` or `In Progress`, and a due date of today or later (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`). `Done` and `Closed` do not count; an unrecognised status is not assumed open and is reported in the log. A subtask assigned to the person counts the same way.

- Nothing is posted if nobody qualifies.
- If Keka or PMS cannot be read completely (error, time-out, HTML page, empty or mismatched list), **nothing is posted**; it retries every 5 minutes until 15:59.
- It is an ordinary Team Activity record with the stable ID `unallocated-YYYY-MM-DD`: saved `PENDING`, marked `SENT` after delivery, retried like every other message, and never created twice for a day, also after a restart.
- It is off unless all Keka and PMS settings are present, so nothing changes where they are not set.
- Credentials are never logged. Keka and PMS are only read, never changed.

## Missing Timesheet (12:00 PM and 3:00 PM IST, Time Tracker only)

A report that lists the people who have **not logged in the Time Tracker today**. It uses the **Time Tracker only**: no PMS, no Keka, no attendance system.

```
🟡 Missing Timesheet — 12:00 PM IST
Date: 14 Oct 2026

🟡 Name one
🟡 Name two

Total missing timesheets: 2
```

**A message is posted only when someone is missing.** If everyone has logged (or is on leave), nothing is posted at all. The same applies when the Time Tracker has no row at all for the day (a holiday, or it is not updating).

How "missing" is decided:

- **Who is expected to log:** everyone with a **work** row in the Time Tracker in the 30 days before today (leave rows alone do not count), minus the always-excluded emails (`MISSING_TIMESHEET_EXCLUDED_EMAILS`, approved leadership; they are never listed and not counted).
- **Has logged:** any Time Tracker row dated today for that email: a started timer, a finished entry, or a **leave** row (leave is a reason to have no timesheet).
- **Missing:** an expected person with no row today. One entry per person; the latest name in the Time Tracker is shown; sorted by name.
- Unreadable rows (no email, bad date) and future-dated rows are ignored. If the Time Tracker cannot be read, or returns nothing usable, **no list is built and nothing is posted**; nothing is guessed.

**Schedule:** Monday to Friday at the times in `MISSING_TIMESHEET_SEND_TIMES` (default and Intigate setting: **12:00 PM and 3:00 PM**), India Standard Time (`Asia/Kolkata`, whatever the server's own time zone is); never on Saturday or Sunday.

- It checks every 10 seconds, so each check happens within about 10 seconds of its time.
- Each time is its own slot. If the Time Tracker or Google Chat fails, that slot retries every minute for 30 minutes. If it still fails, the failure is **logged only**; nothing is posted to the Space about it, and no late list is sent.
- Each slot runs **once per day**, even across restarts (saved in `STATE_DIR/.missing-timesheet-state.json`), whether it sent a message or found nobody missing. A restart after a slot's 30 minutes does not run that slot late.
- It is registered once at start-up and only when `MISSING_TIMESHEET_SCHEDULE_ENABLED=true` and a safe destination exists. `GET /health` shows `missingTimesheet` (scheduled, times, slots sent today, slots with nothing to send, last error; never the webhook).
- It only runs while the service is running at those times. Run only ONE instance.

**Where it posts is an explicit choice:** by default a testing Space (`MISSING_TIMESHEET_WEBHOOK_URL`; the main Space's webhook is refused there). It posts to the **main** Space only when `MISSING_TIMESHEET_POST_TO_MAIN_SPACE=true`; then the main Space's own webhook is used, and `MISSING_TIMESHEET_EXPECTED_SPACE_ID` (recommended) must match it. The start-up log says `posting to the MAIN Space` so you can see which one is active.

```
MISSING_TIMESHEET_POST_TO_MAIN_SPACE=true
MISSING_TIMESHEET_EXPECTED_SPACE_ID=<the main Space's id>
MISSING_TIMESHEET_SCHEDULE_ENABLED=true
MISSING_TIMESHEET_SEND_TIMES=12:00,15:00
MISSING_TIMESHEET_EXCLUDED_EMAILS=<comma-separated emails>
```

**Try it without posting:**

```
npm run missing-timesheet:dry-run     # reads the Time Tracker, prints the message, sends nothing
npm run missing-timesheet:send-test   # posts ONE message to the configured Space (not if nobody is missing)
```

A manual send to the main Space additionally needs `node scripts/missing-timesheet.mjs --send-test --confirm-main-space`. A manual send never touches the schedule's state.

**Deploying** needs only these compiled files in the server's `dist/` (same folders) plus the new settings in the server's `.env`, then a restart. Team Activity and Good Morning are not changed. Do **not** add `KEKA_*` or `PMS_*` settings.

```
dist/config/missingTimesheetConfig.js
dist/services/missingTimesheet.service.js
dist/services/missingTimesheetWatcher.service.js
dist/integrations/googleChat/googleChat.service.js   (adds one method)
dist/server.js                                        (registers the schedule)
```

## Good Morning pictures (rotation)

Instead of one fixed picture you can keep a **list of pictures** and let the service use the next one each weekday, with no daily change or restart.

Put a text file named **`good-morning-images.txt`** in the state folder (`STATE_DIR`, the same folder where `restart-now.txt` goes), one public **https** link per line, in the order you want them used. A ready template is in `deploy-bundle/_upload-to-state-folder-pictures/`. Blank lines and lines starting with `#` are ignored.

How it works:

- Each weekday Good Morning uses the **next picture that has not been used yet** (file order).
- A picture is marked **sent only after Google Chat really accepted the message**. If delivery fails, nothing is used up and the retry uses the same picture. The picture is also fixed for the whole day, so retries and restarts never change it.
- When **every picture has been used**, the "sent" ones become the list again and the round starts over, for ever.
- Edit the list any time (upload the file again): new links join the current round, removed links disappear from "sent" too.
- **No list file** (or no valid link in it): the old single picture, `GOOD_MORNING_IMAGE_URL`, is used exactly as before. Nothing changes until you add the file.
- Weekends use nothing up (the message is only sent on weekdays).

You can see where it stands without opening any code:

| File in the state folder | Content |
|---|---|
| `good-morning-images.txt` | Your list (you upload / edit this) |
| `good-morning-images-status.txt` | Readable: today's picture, what was sent this round, what is still to send |
| `.good-morning-images-state.json` | The service's own memory (do not edit) |

`GET /health` shows `goodMorningImages` (source, how many in the list, sent this round, still to go, and the next picture). The start-up log also says whether the list is in use.

## State files

Written to `STATE_DIR`. Keep this folder when redeploying so already-sent messages are never sent again.

| File | Content |
|---|---|
| `team-activity-state/activity-state.json` | Today's activities: `pending` / `sent` / `skipped` |
| `team-activity-state/sent-entries.csv` | Readable list of what was posted |
| `team-activity-state/skipped-entries.csv` | Readable list of what is waiting or was not posted |
| `.good-morning-state.json` | Last date Good Morning was sent |
| `.good-morning-quote-state.json` | Daily quotes, so they never repeat |
| `good-morning-images.txt` / `good-morning-images-status.txt` / `.good-morning-images-state.json` | Good Morning picture rotation (list, readable status, memory) |
| `.missing-timesheet-state.json` | Which Missing Timesheet time slots were handled each day (sent, or nothing to send) |

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
    goodMorningImages.service.ts       picture rotation (list, sent, new round)
    missingTimesheet.service.ts        who has not logged today (Time Tracker only) + message
    missingTimesheetWatcher.service.ts weekday 12:00 / 15:00 IST schedule, one run per slot per day
    quote.service.ts, quoteLlm.ts      daily quote (AI or built-in)
    logThrottle.ts                     limits repeated error logs
  integrations/
    googleChat/                        webhook sender (text and card + image)
    pms/                               PMS tasks client (used only by the separate Keka unallocated report)
    timeTracker/                       Time Tracker client
test/                                  automated tests
scripts/resend-today.mjs               TEST ONLY: re-posts all of today's activity
scripts/missing-timesheet.mjs          dry run / manual test send for Missing Timesheet
```

## Tests

```bash
npm test
```

Covers detection, duplicates, restarts, retries and 429 handling, malformed data, time limits, quote history, the port-conflict check and clean shutdown, and the Missing Timesheet report: Time Tracker-only detection, message format, no message when nobody is missing, the weekday 12:00 / 15:00 IST schedule, no duplicates, and isolation from the main Space unless switched on (some tests start the real service as a separate process).

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
