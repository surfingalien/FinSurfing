# FinSurf v2 — Stock Intelligence Platform

Real-time portfolio tracking · 5-persona advisory engine · Monte Carlo simulation · Technical analysis

Built with **React 18 + Vite + Tailwind CSS + Recharts** · API proxy via **Express + Yahoo Finance**

---

## Features

| Tab | What it does |
|-----|-------------|
| **Portfolio** | Tracks 20 real positions (AAPL, NVDA, TSLA, MSFT…) with live P&L, sector allocation pie, add/remove |
| **Watchlist** | Live quote table with 52-week range bars, 1-month sparklines, quick-add search |
| **Analyze** | Candlestick/area chart with SMA/EMA/Bollinger/RSI/MACD overlays, 6 ranges, buy-sell signal panel |
| **Advisory** | 5-persona engine: Growth Hawk · Value Seeker · Momentum Trader · Defensive Shield · ESG Conscious + tax tips |
| **Retirement** | Monte Carlo simulation: 500 paths, fan chart, percentile bands, inflation-adjusted median |
| **Screener** | Filterable universe of 30 US stocks by sector, price, P/E with live quotes |
| **Strategies** | Trend Following, Mean Reversion, Breakout, Momentum RS, Dividend Growth — rules + pro/cons |

---

## Local Development

```bash
# 1. Install
npm install

# 2. Start API proxy (port 3001) + Vite dev server (port 5173) concurrently
npm run dev

# Open http://localhost:5173
```

---

## Deploy to Railway

Railway provides free Node.js hosting — the right platform since the app needs a server-side API proxy.

### Steps
1. Go to **[railway.com](https://railway.com)** → **New Project**
2. Choose **"Deploy from GitHub repo"**
3. Select **`surfingalien/FinSurfing`**
4. Railway auto-detects `railway.toml` and runs:
   - Build: `npm install && npm run build`
   - Start: `NODE_ENV=production node server.js`
5. Click **Deploy** → Railway gives you a public URL instantly

### Via Railway CLI (optional)
```bash
npm install -g @railway/cli   # or: brew install railway
railway login
railway up
```

---

## Deploy to Render (Free alternative)

1. [render.com](https://render.com) → New Web Service → Connect GitHub → `surfingalien/FinSurfing`
2. Build Command: `npm install && npm run build`
3. Start Command: `NODE_ENV=production node server.js`
4. Environment: Node 18

---

## Tech Stack

- **Frontend:** React 18, Vite, Tailwind CSS, Recharts, Lucide Icons
- **Backend:** Express proxy server (Yahoo Finance API, server-side to avoid CORS/IP blocks)
- **Indicators:** RSI(14), MACD(12/26/9), SMA, EMA, Bollinger Bands — custom JS implementations
- **State:** React hooks + localStorage persistence
- **Charts:** Recharts (AreaChart, ComposedChart, PieChart)
- **Deployment:** Railway (`railway.toml`) or Render

---

## Telegram bot gateway (optional)

Get AI alerts on your phone and query the Brain from a chat. Fully opt-in —
with no token set, the notifier is a silent no-op and the command bot never
starts. Uses Node's built-in `fetch`, no new dependencies.

Set these env vars (via `@BotFather` for the token; open
`https://api.telegram.org/bot<token>/getUpdates` after messaging your bot to
find your chat id):

```
TELEGRAM_BOT_TOKEN=      # from @BotFather
TELEGRAM_CHAT_ID=        # your numeric chat id
TELEGRAM_ALERTS_ENABLED=true
```

- **Push:** every alert-triggered AI analysis (via the existing
  `alert-broadcaster`) is also sent to Telegram.
- **Commands** (only the configured chat is answered): `/status`,
  `/learnings` (the Brain's current self-learned findings), `/help`.

## White-box, editable AI memory

The AI Brain writes `keyLearnings` from its own resolved-prediction record
every night. That memory is now **correctable**: a signed-in operator can
suppress a wrong or stale finding, pin their own, and set a directive note
right in the **Track Record** panel. Edits are stored as overrides
(`PUT /api/ai-brain/learnings/overrides`, `data/brain-learnings-overrides.json`)
that layer on top of the AI output — so a human correction always wins and is
never clobbered by the next nightly meta-analysis. The merged result is what
gets injected into every scan (and shown by the Telegram `/learnings` command).

---

## Portfolio

`AAPL` `ARM` `ADSK` `AMD` `AVGO` `BABA` `BROS` `CL` `COIN` `GOOG` `INTC` `MSFT` `NVDA` `ORCL` `PG` `QCOM` `SOUN` `TSLA` `TSM` `TXN` `XOM`

> Data powered by Yahoo Finance. Not financial advice.
