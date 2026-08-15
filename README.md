# OpenNOW Queue Bot

Continuous GFN queue probe. Runs N accounts in a queueing loop against one
target game, records per-account queue-time metrics, and surfaces which
account is fastest so you can switch to it when you want to play.

The bot **never holds a streaming session** — it starts a session, polls the
queue until the server reports `status: ready`, then ends the session and
records how long the queue took. A web dashboard shows the live state and the
last-24h ranking.

## Run

```bash
npm install
npm start
```

On start it opens `http://127.0.0.1:5174` in your default browser. From the
dashboard you can:

1. Add accounts (each opens a browser tab to log in — tokens are stored in
   `data/accounts.json`).
2. Enter the target game (numeric `appId` or a GFN UUID; the "Resolve" button
   can turn a UUID into a numeric appId for one of the logged-in accounts).
3. Watch the queue position update every few seconds and the ranking table
   fill in.

Config, metrics, and accounts are persisted in `./data/`.

## How it works

- `src/gfn/auth.ts` — PKCE OAuth via `https://login.nvidia.com/authorize`,
  local callback server, `client_token` + `refresh_token` refresh.
- `src/gfn/session.ts` — `POST /v2/session`, `GET /v2/session/{id}`,
  `DELETE /v2/session/{id}`. Polling surfaces `queuePosition` (see the
  `SESSION_SETUP_PROGRESS` events the official client also logs).
- `src/bot/accountBot.ts` — per-account state machine: `idle → starting →
  queueing → ready → ending → cooldown`.
- `src/bot/orchestrator.ts` — spins up a bot for each enabled account, restarts
  them when config changes.
- `src/metrics/store.ts` — rolling 24h stats: avg / p50 / p95 queue time per
  account, plus error counts.
- `src/dashboard/server.ts` + `web/` — local HTTP server + vanilla
  HTML/CSS/JS UI with SSE for live updates.

## Environment variables

| Name | Default | Purpose |
| --- | --- | --- |
| `QUEUE_BOT_PORT` | `5174` | Dashboard port |
| `QUEUE_BOT_DATA_DIR` | `./data` | Where accounts/metrics/config live |
| `QUEUE_BOT_NO_OPEN` | unset | Set to `1` to suppress auto-opening the browser |

## Caveats

- Local-only. There is no auth on the dashboard — it binds to `127.0.0.1`.
- Tokens are stored in plain JSON. Add encryption before sharing the box.
- GFN likely does not appreciate 5–10 accounts queuing continuously. You carry
  the ToS risk.
- The bot ends the session as soon as it becomes ready; if you want a slot to
  be held warm for you to claim, that needs a separate mode.
