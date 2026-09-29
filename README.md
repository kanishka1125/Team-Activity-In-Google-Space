# Google Space Team Activity

Standalone copy of the Intigate AIOS backend's Google Chat Space notifications:

- **Team Activity**: polls the Time Tracker every 15 s and posts log-ins, project switches and leave to the Google Chat Space.
- **Good Morning**: posts "Good Morning Team☀️" with a daily quote and image on weekdays between 9:30 and 10:00 AM IST.

No AIOS Chat, PMS or frontend code is included.

## Run

```bash
npm ci
cp .env.example .env      # then fill in the values
npm run build
npm start                 # or: npm run dev
```

Health check: `GET http://localhost:4000/health`

**Only run ONE instance with the watchers enabled** (including the old AIOS backend), otherwise messages are sent twice. Use `TEAM_ACTIVITY_WATCHER_ENABLED=false` / `GOOD_MORNING_ENABLED=false` on any other instance.

## How it works

Full details: **[ARCHITECTURE.md](ARCHITECTURE.md)** (data flow, state files, quotes, logs).

```
Time Tracker ──(every 15s)──▶ Team Activity watcher ──▶ Google Chat Space
                                 │  detect → save PENDING → send → mark SENT
                                 ▼
                           state files (STATE_DIR)
                                 ▲
Good Morning (weekdays 9:30–10:00) ── quote (AI or built-in) + image ──▶ Google Chat Space
```

| Folder / file | Purpose |
|---|---|
| `src/server.ts` | Start-up: configuration check, starts both jobs, `/health` |
| `src/config/` | Settings (`runtimeConfig.ts`) and the start-up check |
| `src/services/teamActivity.service.ts` | Detects log-ins, project switches and leave from Time Tracker rows |
| `src/services/teamActivityWatcher.service.ts` | Polling, duplicate prevention, PENDING → SENT, retry/backoff |
| `src/services/teamActivityState.store.ts` | State file `activity-state.json` + `sent-entries.csv` / `skipped-entries.csv`, safe writes, daily reset |
| `src/services/goodMorningWatcher.service.ts` | Good Morning schedule, retry, once per day |
| `src/services/quote.service.ts`, `quoteLlm.ts` | Daily quote (AI via `LLM_*`, otherwise 50 built-in), never repeated |
| `src/services/logThrottle.ts` | Limits repeated error logs |
| `src/integrations/googleChat/` | Google Chat webhook (activity text, Good Morning card with image) |
| `src/integrations/timeTracker/` | Time Tracker client (30 s time limit) |

## State files

Written to `STATE_DIR` (default: the folder the service is started from):

- `team-activity-state/activity-state.json` — today's activities with `pending` / `sent` / `skipped`
- `team-activity-state/sent-entries.csv` / `skipped-entries.csv` — the same, readable in Excel / Google Sheets

The same files are reused every day and start fresh after midnight (IST).
- `.good-morning-state.json` — last date Good Morning was sent
- `.good-morning-quote-state.json` — daily quotes, so quotes don't repeat

Keep this folder when redeploying, so already-sent messages are never sent again.

## Settings

See `.env.example`. Required: `TIME_TRACKER_API_URL`, `GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL`, `GOOD_MORNING_IMAGE_URL`.

## Tests

```bash
npm test
```
