# Architecture — Google Space Team Activity

One small Node.js service that watches Intigate's Time Tracker and posts
to a Google Chat Space:

1. **Team Activity** — who logged in, who switched project, who is on leave.
2. **Good Morning** — one message with a quote and an image, every weekday morning.

No database, no web pages. State is kept in small JSON files.

---

## 1. The big picture

```
                      ┌─────────────────────────────────────────────────────┐
                      │            google-space-team-activity               │
                      │                (one Node.js process)                │
                      │                                                     │
 Time Tracker         │   ┌────────────────────┐   every 15 s               │
 (Google Apps Script) │   │ Team Activity      │◀─────────── timer          │
 returns all rows ───────▶│ watcher            │                            │
 as JSON (≤30 s)      │   │  detect → save →   │── POST text ─────┐         │
                      │   │  send → mark sent  │                  │         │
                      │   └─────────┬──────────┘                  │         │
                      │             │ read / write                ▼         │    Google Chat Space
                      │   ┌─────────▼──────────┐          ┌──────────────┐  │    (incoming webhook)
                      │   │ state files (JSON) │          │ Google Chat  │────────▶ messages appear
                      │   │  team-activity-... │          │ webhook      │  │
                      │   │  .good-morning-... │          │ sender       │  │
                      │   └─────────▲──────────┘          └──────▲───────┘  │
                      │             │ read / write               │          │
                      │   ┌─────────┴──────────┐                 │          │
                      │   │ Good Morning       │── POST card ────┘          │
                      │   │ (weekdays 9:30–10) │    (text + image)          │
 AI (OpenAI-compatible│   └─────────┬──────────┘   every 30 s ◀── timer     │
 API, optional) ◀──────────── quote │                                        │
                      │                                                     │
                      │   GET /health  →  {"status":"ok"}                   │
                      └─────────────────────────────────────────────────────┘
```

**Where things come from**

| What | From | Setting |
|---|---|---|
| Employee rows (name, email, project, start time, date, leave) | Time Tracker Apps Script web app | `TIME_TRACKER_API_URL` |
| Where messages go | Google Chat Space incoming webhook | `GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL` |
| Good Morning picture | Public image URL | `GOOD_MORNING_IMAGE_URL` |
| Good Morning quote | Your AI provider, else a built-in list of 50 | `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` |
| Memory of what was already sent | JSON files on disk | `STATE_DIR` |

---

## 2. Start-up (`src/server.ts`)

1. **Load `.env`** from the folder the service is started in.
2. **Check settings** (`src/config/verifyStartupConfig.ts` → `startupCheck.ts`).
   - `TIME_TRACKER_API_URL` missing → prints a clear message and **stops**.
   - Webhook / image missing → prints what will not work, **keeps running**.
   - AI not set → note only (built-in quotes are used).
   - State folder not writable → clear error.
3. **Start the HTTP health check** on `PORT` (default 4000): `GET /health`.
4. **Start Team Activity** (unless `TEAM_ACTIVITY_WATCHER_ENABLED=false`).
5. **Start Good Morning** (unless `GOOD_MORNING_ENABLED=false`).

---

## 3. Team Activity — how a message is made

Files: `src/services/teamActivityWatcher.service.ts` (the loop),
`src/services/teamActivity.service.ts` (detection),
`src/integrations/timeTracker/*` (reading), `src/integrations/googleChat/*` (sending).

**Every 15 s** (`TEAM_ACTIVITY_POLL_INTERVAL_MS`, min 5 s):

```
1. READ      Time Tracker → all rows (JSON). Gives up after 30 s.
2. CHECK     Skip rows with an unreadable date/time (one warning per row).
3. DETECT    Only today's rows (India time). For each person, by start time:
               first entry today      → "🟢 X has started working on P at 9:26 AM 😄"
               later entry, new proj. → "🟢 X switched to P from Q at 11:30 AM"
               later entry, same proj.→ nothing (not a switch)
               leave row              → "🔴 X is on leave today"
             😄 before 10:00 · 🙂 10:00–10:30 · 🙁 after 10:30
4. IDENTIFY  Each activity gets a stable ID:
               work:  activity-<email>-<date>-<HH:MM>-<project>
               leave: leave-<email>-<date>
             (Not the sheet row number — rows shift when others are
              added/deleted, which used to mix people up.)
5. RECORD    New IDs are saved to today's state file as PENDING
             *before* anything is sent. Duplicate rows collapse to one.
6. SEND      Pending messages go to Google Chat, ~1 per second.
               success           → marked SENT and saved immediately
               429 / 5xx / net   → stays PENDING, retried after 5s, 10s,
                                   20s … up to 5 min (never dropped)
```

A lock makes sure two polls never run at the same time.

**When the service starts** (first poll), activity that is in the Time
Tracker but not yet in the state file happened **while the service was
down**. It is **posted** (all of today, oldest first) and the log says
`N activities happened while the service was down; posting them now.`

Two exceptions, where it is recorded as **skipped** (not posted):
- **brand-new install** (no state files at all) — a first deploy at 3 PM
  must not dump the whole day into the Space;
- **today's state file was unreadable** — it can't tell what was already sent.

Today's leave is always announced once.

---

## 4. State files — the memory

All in `STATE_DIR` (default: the folder the service runs from).

```
team-activity-state/
  activity-state.json     ← the record the service uses (today's entries)
  sent-entries.csv        ← readable "sheet": everything posted today
  skipped-entries.csv     ← readable "sheet": waiting to be sent / not posted
.good-morning-state.json         {"lastSentDate": "2026-09-29"}
.good-morning-quote-state.json   {"dailyQuotes": {date: quote}, "usedQuotes": [...]}
```

The **same three files are used every day** (no new files per day).
`activity-state.json` looks like `{"version": 2, "days": {"2026-09-29": [ …records… ]}}`.

Each Team Activity record:

```json
{
  "activityId": "activity-jonish@…-2026-09-29-10:44-kfh new",
  "employee": "Jonish Kumar", "fromProject": null, "toProject": "KFH New",
  "timestamp": "10:44 AM",
  "message": "🟢 Jonish Kumar has started working on KFH New at 10:44 AM 🙁",
  "status": "pending | sent | skipped",
  "attempts": 0, "lastError": null, "nextAttemptAt": null,
  "sendStartedAt": null, "detectedAt": "…", "sentAt": "…"
}
```

- **CSV "sheets"** open in Excel / Google Sheets and are rebuilt on every
  save: `sent-entries.csv` (date, time, employee, activity, from/to project,
  message, sent at) and `skipped-entries.csv` (plus status, reason — e.g. the
  Google Chat error — attempts, next try). When an error clears, the row moves
  from *skipped* to *sent*.
  If a CSV is open in Excel it can't be updated for a moment — one warning,
  sending is not affected, it is updated on the next save.
- **Safe writes:** written to a temp file, then swapped in — a crash can't
  leave half a file. An unreadable file is set aside as `…corrupt-<time>`.
- **Start fresh daily:** on the first check after midnight (IST) the previous
  day's entries are removed from all three files, so they only show the new
  day. A day with a message still waiting stays in the same files until it
  is sent. (Files from older versions, `YYYY-MM-DD.json`, are merged in
  automatically and removed.)
- **Save fails** (disk full / no permission): nothing is sent until saving
  works again, with a clear error naming the folder.

**After a crash or restart:** SENT → never sent again; PENDING → sent;
entries made while it was down → posted; killed in the exact moment of
sending → resent once (logged as "interrupted by a restart"; may appear
twice rather than be lost).

---

## 5. Good Morning (`src/services/goodMorningWatcher.service.ts`)

**Every 30 s:**

```
weekday? (Mon–Fri, India time)      no → wait
between 9:30 and 10:00?             no → wait (after 10:00: logs "NOT sent" if all tries failed)
already sent today? (state file)    yes → done for the day
get today's quote                   (same quote for every retry today)
POST card: "Good Morning Team☀️\n\n<quote>" + image
  success → save today's date → no more today
  failure → retry every 60 s until 10:00
```

### Quotes (`src/services/quote.service.ts`, `quoteLlm.ts`) — never repeated

1. **AI configured** (`LLM_*`): asks for one original 15–30 word workplace
   quote. The request includes:
   - **today's theme**, rotating daily: consistency, ownership, teamwork,
     learning, excellence, leadership, discipline, progress,
     communication, accountability, adaptability, helping colleagues;
   - **the last 30 quotes**, with "do not repeat or reuse their wording".
2. **Repeat check** on every answer, against **all** earlier quotes:
   rejected if it starts with the same 5 words, or shares 60 %+ of its
   meaningful words. Then the AI is asked again (up to 5 times).
3. **AI off / failing / only near-copies:** one of **50 built-in quotes**:
   never-used first; after all 50, the one used longest ago.
4. The chosen quote is saved for the day, so retries and restarts use the same one.

---

## 6. Logs you will see

| Log line | Meaning |
|---|---|
| `Startup configuration check: OK` | Settings fine |
| `watcher started (polling every 15s, state: …)` | Team Activity running; shows state folder |
| `state loaded … N sent, N pending, N skipped` | Memory restored after restart |
| `N activities happened while the service was down; posting them now.` | Catch-up after downtime |
| `could not update …csv … open in Excel?` | CSV locked; sending unaffected |
| `Team Activity sent: …` | Delivered to Google Chat |
| `Google Chat send failed … kept as pending` | Will retry; nothing lost |
| `could not read Time Tracker; will retry` | Apps Script hiccup; next poll retries |
| `… (still failing: N times …)` | Same problem continuing (repeats limited to one per 5 min) |
| `… reachable again / working again` | Recovered |
| `Good Morning message sent for YYYY-MM-DD.` | Good Morning delivered |

---

## 7. Folder map

```
google-space-team-activity/
├── src/
│   ├── server.ts                          start-up + /health
│   ├── config/
│   │   ├── runtimeConfig.ts               all settings, defaults, STATE_DIR
│   │   ├── startupCheck.ts                what is missing and why it matters
│   │   └── verifyStartupConfig.ts         runs the check before anything else
│   ├── services/
│   │   ├── teamActivity.service.ts        rows → activities (login/switch/leave)
│   │   ├── teamActivityWatcher.service.ts poll, dedupe, PENDING→SENT, retries
│   │   ├── teamActivityState.store.ts     daily JSON files, safe writes, clean-up
│   │   ├── goodMorningWatcher.service.ts  9:30–10:00 weekday message
│   │   ├── quote.service.ts               daily quote, no repeats
│   │   ├── quoteLlm.ts                    AI call for the quote
│   │   └── logThrottle.ts                 limits repeated error lines
│   └── integrations/
│       ├── googleChat/googleChat.service.ts   webhook POSTs (text / card+image)
│       └── timeTracker/                       Time Tracker client (30 s limit), types
├── test/                 automated tests (npm test)
├── scripts/resend-today.mjs   TEST ONLY: re-posts all of today's activity
├── .env.example          settings template (copy to .env)
├── package.json          dotenv, express, openai
└── tsconfig.json
```

---

## 8. Running it

```bash
npm ci
cp .env.example .env        # fill in the values
npm run build
npm start
```

**Resources:** about 100 MB RAM while running (measured); ~250 MB disk
with packages. A 512 MB–1 GB server is enough.

**Rules for deployment**

- Run **one** instance with the watchers enabled — two would post everything twice.
- Keep `STATE_DIR` on a folder that survives redeploys and restarts.
- Keep the service running by **10:00 AM** on weekdays for Good Morning.
- Never commit `.env`.
