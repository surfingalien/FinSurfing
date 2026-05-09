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

## Portfolio

`AAPL` `ARM` `ADSK` `AMD` `AVGO` `BABA` `BROS` `CL` `COIN` `GOOG` `INTC` `MSFT` `NVDA` `ORCL` `PG` `QCOM` `SOUN` `TSLA` `TSM` `TXN` `XOM`

> Data powered by Yahoo Finance. Not financial advice.
