// Pre-loaded from Portfolio_Positions_Apr-21-2026.numbers (Fidelity Individual TOD account)
export const INITIAL_PORTFOLIO = [
  { symbol: 'AAPL',  name: 'Apple Inc.',                      shares: 10,  avgCost: 175.00, sector: 'Technology' },
  { symbol: 'ADSK',  name: 'Autodesk Inc.',                   shares: 5,   avgCost: 260.00, sector: 'Technology' },
  { symbol: 'AMD',   name: 'Advanced Micro Devices Inc.',     shares: 15,  avgCost: 145.00, sector: 'Technology' },
  { symbol: 'AVGO',  name: 'Broadcom Inc.',                   shares: 8,   avgCost: 165.00, sector: 'Technology' },
  { symbol: 'BABA',  name: 'Alibaba Group Holding Ltd.',      shares: 20,  avgCost: 80.00,  sector: 'Consumer Cyclical' },
  { symbol: 'BROS',  name: 'Dutch Bros Inc.',                 shares: 25,  avgCost: 38.00,  sector: 'Consumer Cyclical' },
  { symbol: 'CL',    name: 'Colgate-Palmolive Co.',           shares: 12,  avgCost: 88.00,  sector: 'Consumer Defensive' },
  { symbol: 'COIN',  name: 'Coinbase Global Inc. Class A',    shares: 10,  avgCost: 200.00, sector: 'Financial Services' },
  { symbol: 'GOOG',  name: 'Alphabet Inc. Class C',           shares: 12,  avgCost: 155.00, sector: 'Communication Services' },
  { symbol: 'INTC',  name: 'Intel Corp.',                     shares: 30,  avgCost: 30.00,  sector: 'Technology' },
  { symbol: 'MSFT',  name: 'Microsoft Corp.',                 shares: 10,  avgCost: 390.00, sector: 'Technology' },
  { symbol: 'NVDA',  name: 'NVIDIA Corp.',                    shares: 20,  avgCost: 85.00,  sector: 'Technology' },
  { symbol: 'ORCL',  name: 'Oracle Corp.',                    shares: 10,  avgCost: 120.00, sector: 'Technology' },
  { symbol: 'PG',    name: 'Procter & Gamble Co.',            shares: 8,   avgCost: 150.00, sector: 'Consumer Defensive' },
  { symbol: 'QCOM',  name: 'Qualcomm Inc.',                   shares: 12,  avgCost: 155.00, sector: 'Technology' },
  { symbol: 'SOUN',  name: 'SoundHound AI Inc.',              shares: 100, avgCost: 8.00,   sector: 'Technology' },
  { symbol: 'TSLA',  name: 'Tesla Inc.',                      shares: 10,  avgCost: 220.00, sector: 'Consumer Cyclical' },
  { symbol: 'TSM',   name: 'Taiwan Semiconductor Mfg. Co.',  shares: 15,  avgCost: 150.00, sector: 'Technology' },
  { symbol: 'TXN',   name: 'Texas Instruments Inc.',          shares: 10,  avgCost: 175.00, sector: 'Technology' },
  { symbol: 'XOM',   name: 'Exxon Mobil Corp.',               shares: 10,  avgCost: 110.00, sector: 'Energy' },
]

export const TICKER_SYMBOLS = ['SPY', 'QQQ', 'DIA', 'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'META', 'GOOGL', 'AMD', 'TSM', 'COIN', 'SOUN']

export const MARKET_INDICES = ['SPY', 'QQQ', '^VIX', 'GLD']

// CFP-style watchlist buy-zone analysis cards
export const WATCHLIST_ALERTS = [
  {
    symbol: 'ARM',
    name: 'Arm Holdings plc',
    thesis: 'v9 royalty inflection + automotive/AI edge expansion',
    holdingPeriod: '18–24 months',
    currentNote: 'Near 52W high after +82% run — NOT a buy at current levels',
    entryZone: { low: 178, high: 180, note: 'Prior breakout support, ~13% pullback' },
    targets: [
      { price: 230, pct: '+27%', action: 'Sell 25%', note: '1st profit-take' },
      { price: 270, pct: '+50%', action: 'Sell 25%', note: '2nd profit-take' },
      { price: null, pct: null,  action: 'Hold rest', note: 'Trail 20% stop on remainder' },
    ],
    trailingStop: 20,
    alerts: [
      { type: 'below', threshold: 181, label: 'Entry zone — start accumulating' },
      { type: 'above', threshold: 230, label: '1st profit target hit' },
    ],
  },
  {
    symbol: 'PLTR',
    name: 'Palantir Technologies',
    thesis: 'AIP/AI platform adoption across US defense + enterprise',
    holdingPeriod: '12–18 months',
    currentNote: 'Momentum strong but extended — wait for 8–10% pullback',
    entryZone: { low: 90, high: 96, note: '21-day EMA support zone' },
    targets: [
      { price: 130, pct: '+36%', action: 'Sell 30%', note: '1st profit-take' },
      { price: 160, pct: '+67%', action: 'Sell 30%', note: '2nd profit-take' },
      { price: null, pct: null,  action: 'Hold rest', note: 'Trail 15% stop on remainder' },
    ],
    trailingStop: 15,
    alerts: [
      { type: 'below', threshold: 97, label: 'Entry zone — scale in' },
      { type: 'above', threshold: 130, label: '1st profit target hit' },
    ],
  },
  {
    symbol: 'SOUN',
    name: 'SoundHound AI Inc.',
    thesis: 'Voice AI for automotive + QSR; Nvidia-backed',
    holdingPeriod: '12–24 months',
    currentNote: 'Speculative small-cap — size position accordingly (< 2% portfolio)',
    entryZone: { low: 7, high: 9, note: 'Support at prior breakout base' },
    targets: [
      { price: 14, pct: '+67%', action: 'Sell 33%', note: '1st profit-take' },
      { price: 20, pct: '+138%', action: 'Sell 33%', note: '2nd profit-take' },
      { price: null, pct: null,  action: 'Hold rest', note: 'Trail 25% stop' },
    ],
    trailingStop: 25,
    alerts: [
      { type: 'below', threshold: 9.5, label: 'Entry zone — begin accumulating' },
      { type: 'above', threshold: 14, label: '1st profit target hit' },
    ],
  },
]

export const SCREENER_UNIVERSE = [
  { symbol: 'AAPL',  name: 'Apple Inc.',              sector: 'Technology',             mktCap: 3.5e12, pe: 32 },
  { symbol: 'MSFT',  name: 'Microsoft Corp.',         sector: 'Technology',             mktCap: 3.2e12, pe: 35 },
  { symbol: 'NVDA',  name: 'NVIDIA Corp.',            sector: 'Technology',             mktCap: 2.8e12, pe: 45 },
  { symbol: 'GOOG',  name: 'Alphabet Inc.',           sector: 'Communication Services', mktCap: 2.1e12, pe: 22 },
  { symbol: 'AMZN',  name: 'Amazon.com Inc.',         sector: 'Consumer Cyclical',      mktCap: 2.2e12, pe: 42 },
  { symbol: 'META',  name: 'Meta Platforms Inc.',     sector: 'Communication Services', mktCap: 1.5e12, pe: 27 },
  { symbol: 'TSLA',  name: 'Tesla Inc.',              sector: 'Consumer Cyclical',      mktCap: 1.1e12, pe: 85 },
  { symbol: 'AVGO',  name: 'Broadcom Inc.',           sector: 'Technology',             mktCap: 0.85e12, pe: 32 },
  { symbol: 'LLY',   name: 'Eli Lilly & Co.',         sector: 'Health Care',            mktCap: 0.9e12, pe: 65 },
  { symbol: 'JPM',   name: 'JPMorgan Chase & Co.',    sector: 'Financials',             mktCap: 0.7e12, pe: 14 },
  { symbol: 'V',     name: 'Visa Inc.',               sector: 'Financials',             mktCap: 0.6e12, pe: 28 },
  { symbol: 'WMT',   name: 'Walmart Inc.',            sector: 'Consumer Defensive',     mktCap: 0.58e12, pe: 31 },
  { symbol: 'UNH',   name: 'UnitedHealth Group',      sector: 'Health Care',            mktCap: 0.55e12, pe: 18 },
  { symbol: 'ORCL',  name: 'Oracle Corp.',            sector: 'Technology',             mktCap: 0.42e12, pe: 22 },
  { symbol: 'COST',  name: 'Costco Wholesale Corp.',  sector: 'Consumer Defensive',     mktCap: 0.42e12, pe: 52 },
  { symbol: 'NFLX',  name: 'Netflix Inc.',            sector: 'Communication Services', mktCap: 0.45e12, pe: 52 },
  { symbol: 'AMD',   name: 'Advanced Micro Devices',  sector: 'Technology',             mktCap: 0.28e12, pe: 38 },
  { symbol: 'COIN',  name: 'Coinbase Global Inc.',    sector: 'Financials',             mktCap: 0.06e12, pe: 28 },
  { symbol: 'PLTR',  name: 'Palantir Technologies',   sector: 'Technology',             mktCap: 0.22e12, pe: 185 },
  { symbol: 'TSMC',  name: 'Taiwan Semiconductor',    sector: 'Technology',             mktCap: 0.85e12, pe: 22 },
  { symbol: 'XOM',   name: 'Exxon Mobil Corp.',       sector: 'Energy',                 mktCap: 0.5e12, pe: 14 },
  { symbol: 'PG',    name: 'Procter & Gamble Co.',    sector: 'Consumer Defensive',     mktCap: 0.38e12, pe: 26 },
  { symbol: 'QCOM',  name: 'Qualcomm Inc.',           sector: 'Technology',             mktCap: 0.18e12, pe: 18 },
  { symbol: 'INTC',  name: 'Intel Corp.',             sector: 'Technology',             mktCap: 0.10e12, pe: 12 },
  { symbol: 'CL',    name: 'Colgate-Palmolive Co.',   sector: 'Consumer Defensive',     mktCap: 0.08e12, pe: 26 },
  { symbol: 'SOUN',  name: 'SoundHound AI Inc.',      sector: 'Technology',             mktCap: 0.005e12, pe: null },
  { symbol: 'ADSK',  name: 'Autodesk Inc.',           sector: 'Technology',             mktCap: 0.05e12, pe: 55 },
  { symbol: 'BABA',  name: 'Alibaba Group Holding',   sector: 'Consumer Cyclical',      mktCap: 0.22e12, pe: 12 },
  { symbol: 'BROS',  name: 'Dutch Bros Inc.',         sector: 'Consumer Cyclical',      mktCap: 0.006e12, pe: 80 },
  { symbol: 'TXN',   name: 'Texas Instruments Inc.',  sector: 'Technology',             mktCap: 0.16e12, pe: 32 },
]
