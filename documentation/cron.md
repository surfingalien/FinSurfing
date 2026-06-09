# Cron / Scheduled Jobs — FinSurfing

## Scheduler Architecture

In-process `setInterval` tick every 60 seconds (`lib/scheduler.js`). No external cron dependency. Jobs are registered at startup via `lib/scheduled-jobs.js:init()`, called from `server.js`.

**Idempotency:** Each job checks `lastRun` timestamp — skips if already ran in the current clock-minute.  
**Trigger route:** `POST /api/scheduler/jobs/:id/trigger` — fire-and-forget, **no authentication**.  
**Status route:** `GET /api/scheduler/jobs` — returns last result + error for each job, **no authentication**.

## Job Inventory

| Job ID | Schedule | Function | Secrets | Timeout | Retry |
|---|---|---|---|---|---|
| `morning-brief-email` | Daily 9:30 AM ET, Mon–Fri | `morningBriefEmail()` | `ANTHROPIC_API_KEY`, `MORNING_BRIEF_EMAIL`/`ADMIN_EMAIL`, email service | 300 s (AI Brain) | None |
| `pre-market-scan` | Daily 8:30 AM server time | `preMarketScan()` | `ANTHROPIC_API_KEY` | 90 s | None |
| `earnings-watch` | Daily 7:00 AM server time | `earningsWatch()` | `FMP_API_KEY` | 15 s | None |
| `macro-pulse` | Hourly :00 | `macroPulse()` | `FRED_API_KEY` | 30 s | None |
| `hourly-ai-scan` | Hourly :05, Mon–Fri | `hourlyAiScan()` | `ANTHROPIC_API_KEY` | 120 s | None |
| `watchlist-digest` | Daily 8:00 AM ET, Mon–Fri | `watchlistDigest()` | `ANTHROPIC_API_KEY` | 30 s/symbol | None |
| `alt-data-refresh` | Daily 6:30 AM server time | `altDataRefresh()` | None (public APIs) | — | None |

## Idempotency Notes

- `morning-brief-email`: Not idempotent if triggered multiple times — sends duplicate emails. No deduplication.
- `hourly-ai-scan`: Overwrites `_scanCache.broad` — idempotent.
- `watchlist-digest`: Overwrites `_digestCache.results` — idempotent.
- `pre-market-scan`, `earnings-watch`, `macro-pulse`: Return data only, no side effects beyond cache — idempotent.

## Internal Call Authentication

Jobs call the app's own API via loopback (`http://127.0.0.1:{PORT}/api/...`) with header `x-internal: '1'`. This header is how server.js identifies internal calls. **It is not cryptographically signed and is forgeable from outside the process.**

## Operational Notes

- `GET /api/scheduler/jobs` shows each job's `lastRun`, `status` (`idle | running | done | failed`), and `result.error`.
- To manually trigger: `POST /api/scheduler/jobs/{id}/trigger` (no auth required).
- If the server restarts after 9:30 AM ET, `morning-brief-email` will not run until next business day (no catch-up logic).
- `watchlist-digest` uses a static fallback watchlist (`['AAPL','NVDA','MSFT','TSLA','SPY','BTC-USD','ETH-USD']`) — not tied to any user's actual watchlist.
