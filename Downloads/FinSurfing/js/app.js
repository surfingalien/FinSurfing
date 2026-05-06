/* ═══════════════════════════════════════════════
   FinSurf — Main Application
═══════════════════════════════════════════════ */

const state = {
  tab: 'overview',
  symbol: null,
  period: '1y',
  interval: '1d',
  indicators: { sma20: false, sma50: true, sma200: false, ema: false, bb: true, volume: true },
  charts: { main: null, rsi: null, macd: null },
  series: {},
  screenerData: [...SCREENER_STOCKS],
  moversMode: 'gainers'
};

/* ════════════════════════════════════
   INITIALIZATION
════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  initNav();
  initSearch();
  initPeriodButtons();
  initIndicatorToggles();
  initScreener();
  initMiniTabs();
  updateClock();
  setInterval(updateClock, 1000);
  loadOverview();
});

/* ════════════════════════════════════
   NAVIGATION
════════════════════════════════════ */
function initNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(el => el.classList.toggle('active', el.id === `tab-${tab}`));

  if (tab === 'analyze' && !state.symbol) {
    setTimeout(() => document.getElementById('stockSearch')?.focus(), 100);
  }
  if (tab === 'screener' && state.screenerData[0]?.price === 0) {
    loadScreenerPrices();
  }
}

/* ════════════════════════════════════
   CLOCK & MARKET STATUS
════════════════════════════════════ */
function updateClock() {
  const now = new Date();
  const etOptions = { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true };
  const etStr = now.toLocaleTimeString('en-US', etOptions);
  const el = document.getElementById('headerTime');
  if (el) el.textContent = `ET ${etStr}`;

  const etDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = etDate.getDay();
  const h = etDate.getHours(), m = etDate.getMinutes();
  const mins = h * 60 + m;
  const isWeekday = day >= 1 && day <= 5;
  const isRegular = mins >= 570 && mins < 960; // 9:30 AM – 4:00 PM ET
  const isPreMkt = mins >= 240 && mins < 570;
  const isAfterHrs = mins >= 960 && mins < 1200;

  const dot = document.querySelector('.status-dot');
  const txt = document.getElementById('marketStatusText');
  if (isWeekday && isRegular) {
    dot?.classList.remove('closed');
    if (txt) txt.textContent = 'Market Open';
  } else if (isWeekday && isPreMkt) {
    dot?.classList.add('closed');
    if (txt) txt.textContent = 'Pre-Market';
  } else if (isWeekday && isAfterHrs) {
    dot?.classList.add('closed');
    if (txt) txt.textContent = 'After-Hours';
  } else {
    dot?.classList.add('closed');
    if (txt) txt.textContent = 'Market Closed';
  }

  const dateEl = document.getElementById('overviewDate');
  if (dateEl) {
    dateEl.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }
}

/* ════════════════════════════════════
   OVERVIEW
════════════════════════════════════ */
async function loadOverview() {
  await Promise.allSettled([
    loadIndices(),
    loadTicker(),
    loadSectors(),
    loadQuickTable()
  ]);
  loadMovers('gainers');
}

async function loadIndices() {
  try {
    const quotes = await fetchMultiQuote(INDEX_ETFS);
    const grid = document.getElementById('indicesGrid');
    if (!grid) return;

    grid.querySelectorAll('.index-card').forEach(card => {
      const sym = card.dataset.symbol;
      const q = quotes.find(x => x.symbol === sym || (sym === '^VIX' && x.symbol === '%5EVIX'));
      if (!q) return;

      card.classList.remove('skeleton', 'up', 'down');
      const up = q.changePct >= 0;
      card.classList.add(up ? 'up' : 'down');

      card.querySelector('.index-price').textContent = `$${q.price?.toFixed(2) || '—'}`;
      const chgEl = card.querySelector('.index-change');
      chgEl.textContent = `${up ? '+' : ''}${q.changePct?.toFixed(2) || '0'}% (${up ? '+' : ''}${q.change?.toFixed(2) || '0'})`;
      chgEl.className = `index-change ${up ? 'up' : 'down'}`;

      card.onclick = () => { analyzeSymbol(sym.replace('^', '%5E')); switchTab('analyze'); };
    });
  } catch (e) {
    console.warn('Indices load failed:', e);
  }
}

async function loadTicker() {
  try {
    const quotes = await fetchMultiQuote(TICKER_SYMBOLS);
    const track = document.getElementById('tickerTrack');
    if (!track || !quotes.length) return;

    track.innerHTML = '';
    // Double for seamless loop
    [...quotes, ...quotes].forEach(q => {
      const up = q.changePct >= 0;
      const item = document.createElement('div');
      item.className = 'ticker-item';
      item.innerHTML = `<span class="ticker-symbol">${q.symbol}</span><span class="ticker-price">$${q.price?.toFixed(2) || '—'}</span><span class="ticker-chg ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(q.changePct || 0).toFixed(2)}%</span>`;
      item.onclick = () => { analyzeSymbol(q.symbol); switchTab('analyze'); };
      track.appendChild(item);
    });
  } catch (e) {
    console.warn('Ticker load failed:', e);
  }
}

async function loadSectors() {
  try {
    const quotes = await fetchMultiQuote(SECTOR_ETFS);
    document.querySelectorAll('.sector-cell').forEach(cell => {
      const sym = cell.dataset.symbol;
      const q = quotes.find(x => x.symbol === sym);
      if (!q) return;

      const pct = q.changePct || 0;
      cell.classList.remove('skeleton', 'hot', 'warm', 'neutral', 'cool', 'cold');
      let cls = 'neutral';
      if (pct > 1.5) cls = 'hot';
      else if (pct > 0.3) cls = 'warm';
      else if (pct < -1.5) cls = 'cold';
      else if (pct < -0.3) cls = 'cool';
      cell.classList.add(cls);
      cell.textContent = `${cell.dataset.sector}\n${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
      cell.style.whiteSpace = 'pre';
      cell.onclick = () => { analyzeSymbol(sym); switchTab('analyze'); };
    });
  } catch (e) {
    console.warn('Sectors load failed:', e);
  }
}

async function loadQuickTable() {
  try {
    const syms = TOP_STOCKS.map(s => s.symbol);
    const quotes = await fetchMultiQuote(syms);
    const tbody = document.getElementById('quickTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';
    syms.forEach(sym => {
      const q = quotes.find(x => x.symbol === sym);
      const info = TOP_STOCKS.find(s => s.symbol === sym);
      if (!q) return;

      const up = (q.changePct || 0) >= 0;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="td-symbol">${sym}</td>
        <td>${q.name || info?.name || '—'}</td>
        <td>$${q.price?.toFixed(2) || '—'}</td>
        <td class="${up ? 'td-up' : 'td-down'}">${up ? '+' : ''}${q.change?.toFixed(2) || '0'}</td>
        <td class="${up ? 'td-up' : 'td-down'}">${up ? '+' : ''}${q.changePct?.toFixed(2) || '0'}%</td>
        <td>${fmtVolume(q.volume)}</td>
        <td>${fmtLargeNum(q.marketCap)}</td>
        <td>${q.pe ? fmtNum(q.pe, 1) : '—'}</td>
        <td><button class="analyze-link" onclick="analyzeSymbol('${sym}');switchTab('analyze')">Analyze →</button></td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    document.getElementById('quickTableBody').innerHTML = '<tr><td colspan="9" class="table-loading">Data unavailable — try refreshing</td></tr>';
  }
}

function initMiniTabs() {
  document.querySelectorAll('.tab-mini-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-mini-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.moversMode = btn.dataset.target;
      loadMovers(btn.dataset.target);
    });
  });
}

async function loadMovers(type) {
  const moverSymbols = {
    gainers: ['NVDA','TSLA','META','NFLX','AMD','AVGO','ARM','NOW','PLTR','UBER'],
    losers: ['XOM','CVX','JNJ','PG','KO','PEP','SO','NEE','AMT','MRK'],
    active: ['AAPL','MSFT','AMZN','GOOGL','TSLA','NVDA','META','NFLX','AMD','V']
  }[type] || [];

  try {
    const quotes = await fetchMultiQuote(moverSymbols);
    if (type === 'gainers') quotes.sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
    if (type === 'losers') quotes.sort((a, b) => (a.changePct || 0) - (b.changePct || 0));

    const list = document.getElementById('moverList');
    if (!list) return;
    list.innerHTML = '';

    quotes.forEach(q => {
      const up = (q.changePct || 0) >= 0;
      const div = document.createElement('div');
      div.className = 'mover-item';
      div.innerHTML = `
        <div class="mover-left">
          <span class="mover-symbol">${q.symbol}</span>
          <span class="mover-name">${q.name || SYMBOL_DB[q.symbol] || ''}</span>
        </div>
        <div class="mover-right">
          <span class="mover-price">$${q.price?.toFixed(2) || '—'}</span>
          <span class="mover-chg ${up ? 'up' : 'down'}">${up ? '+' : ''}${q.changePct?.toFixed(2) || '0'}%</span>
        </div>
      `;
      div.onclick = () => { analyzeSymbol(q.symbol); switchTab('analyze'); };
      list.appendChild(div);
    });
  } catch {
    document.getElementById('moverList').innerHTML = '<div class="mover-placeholder">Data unavailable</div>';
  }
}

/* ════════════════════════════════════
   SEARCH
════════════════════════════════════ */
function initSearch() {
  const input = document.getElementById('stockSearch');
  const sug = document.getElementById('searchSuggestions');
  if (!input || !sug) return;

  let debounceTimer;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (!q) { sug.classList.remove('open'); return; }
    debounceTimer = setTimeout(() => doSearch(q), 280);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const val = input.value.trim().toUpperCase();
      if (val) { analyzeSymbol(val); sug.classList.remove('open'); }
    }
    if (e.key === 'Escape') sug.classList.remove('open');
  });

  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !sug.contains(e.target)) sug.classList.remove('open');
  });
}

async function doSearch(query) {
  const sug = document.getElementById('searchSuggestions');

  // First try local DB
  const localMatches = Object.entries(SYMBOL_DB)
    .filter(([sym, name]) =>
      sym.includes(query.toUpperCase()) || name.toLowerCase().includes(query.toLowerCase())
    )
    .slice(0, 5)
    .map(([sym, name]) => ({ symbol: sym, name, type: 'EQUITY', exchange: '' }));

  if (localMatches.length) {
    showSuggestions(localMatches);
  }

  // Then try live search
  try {
    const results = await searchTicker(query);
    if (results.length) showSuggestions(results);
  } catch {}
}

function showSuggestions(results) {
  const sug = document.getElementById('searchSuggestions');
  sug.innerHTML = '';
  results.forEach(r => {
    const div = document.createElement('div');
    div.className = 'suggestion-item';
    div.innerHTML = `
      <div>
        <div class="suggestion-symbol">${r.symbol}</div>
        <div class="suggestion-name">${r.name}</div>
      </div>
      <span class="suggestion-type">${r.type || 'EQUITY'}</span>
    `;
    div.addEventListener('click', () => {
      document.getElementById('stockSearch').value = r.symbol;
      sug.classList.remove('open');
      analyzeSymbol(r.symbol);
    });
    sug.appendChild(div);
  });
  sug.classList.add('open');
}

/* ════════════════════════════════════
   PERIOD & INDICATOR CONTROLS
════════════════════════════════════ */
function initPeriodButtons() {
  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.period = btn.dataset.period;
      state.interval = btn.dataset.interval;
      if (state.symbol) loadChart(state.symbol);
    });
  });
}

function initIndicatorToggles() {
  document.querySelectorAll('.ind-btn').forEach(btn => {
    const ind = btn.dataset.ind;
    btn.classList.toggle('active', state.indicators[ind]);
    btn.addEventListener('click', () => {
      state.indicators[ind] = !state.indicators[ind];
      btn.classList.toggle('active', state.indicators[ind]);
      if (state.symbol && state._lastChartData) {
        renderOverlays(state._lastChartData);
      }
    });
  });
}

/* ════════════════════════════════════
   ANALYZE — MAIN ENTRY
════════════════════════════════════ */
async function analyzeSymbol(symbol) {
  if (!symbol) return;
  symbol = symbol.toUpperCase();
  state.symbol = symbol;

  document.getElementById('stockSearch').value = symbol;

  // Show loading state
  showStockHeader(symbol, null);
  document.getElementById('chartStatus').style.display = 'none';
  document.getElementById('sidebarPlaceholder').style.display = 'none';
  document.getElementById('signalCard').style.display = 'none';
  document.getElementById('fundamentalsCard').style.display = 'none';
  document.getElementById('aboutCard').style.display = 'none';

  try {
    const [chartData, summary] = await Promise.allSettled([
      loadChart(symbol),
      fetchSummary(symbol)
    ]);

    if (summary.status === 'fulfilled' && summary.value) {
      renderFundamentals(summary.value);
      renderAbout(summary.value);
    }
  } catch (e) {
    console.error('Analysis failed:', e);
    document.getElementById('chartStatus').textContent = `Could not load data for ${symbol}. Please check the symbol and try again.`;
    document.getElementById('chartStatus').style.display = 'block';
  }
}

/* ════════════════════════════════════
   CHART
════════════════════════════════════ */
async function loadChart(symbol) {
  const data = await fetchChart(symbol, state.interval, state.period);
  state._lastChartData = data;

  updateStockHeader(data);
  initCharts(data);
  renderOverlays(data);
  renderSignalPanel(data);

  return data;
}

function initCharts(data) {
  const chartOptions = {
    layout: { background: { color: '#0d1117' }, textColor: '#8b949e' },
    grid: { vertLines: { color: '#161b22' }, horzLines: { color: '#161b22' } },
    crosshair: { mode: 1, vertLine: { color: '#e3a012', width: 1, style: 3 }, horzLine: { color: '#e3a012', width: 1, style: 3 } },
    timeScale: { borderColor: '#21262d', timeVisible: true, secondsVisible: false },
    rightPriceScale: { borderColor: '#21262d' },
    handleScroll: { mouseWheel: true, pressedMouseMove: true },
    handleScale: { mouseWheel: true, pinch: true }
  };

  // Destroy existing
  const mc = document.getElementById('mainChart');
  const rc = document.getElementById('rsiChart');
  const macdC = document.getElementById('macdChart');
  mc.innerHTML = ''; rc.innerHTML = ''; macdC.innerHTML = '';

  // Main chart
  state.charts.main = LightweightCharts.createChart(mc, { ...chartOptions, height: 440 });
  const candleSeries = state.charts.main.addCandlestickSeries({
    upColor: '#3fb950', downColor: '#f85149',
    borderUpColor: '#3fb950', borderDownColor: '#f85149',
    wickUpColor: '#3fb950', wickDownColor: '#f85149'
  });

  const candleData = data.candles.map(c => ({
    time: c.time, open: c.open, high: c.high, low: c.low, close: c.close
  }));
  candleSeries.setData(candleData);
  state.series.candle = candleSeries;

  // Volume as histogram on main chart
  if (state.indicators.volume) {
    const volSeries = state.charts.main.addHistogramSeries({
      color: '#21262d',
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      scaleMargins: { top: 0.8, bottom: 0 }
    });
    state.charts.main.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    volSeries.setData(data.candles.map(c => ({
      time: c.time,
      value: c.volume,
      color: c.close >= c.open ? 'rgba(63,185,80,0.35)' : 'rgba(248,81,73,0.35)'
    })));
    state.series.volume = volSeries;
  }

  // RSI chart
  state.charts.rsi = LightweightCharts.createChart(rc, { ...chartOptions, height: 120 });
  const rsiData = calcRSI(data.candles.map(c => c.close));
  const rsiSeries = state.charts.rsi.addLineSeries({ color: '#8957e5', lineWidth: 1.5, priceLineVisible: false });
  rsiSeries.setData(data.candles.map((c, i) => rsiData[i] !== null ? { time: c.time, value: rsiData[i] } : null).filter(Boolean));

  // RSI reference lines
  const rsi70 = state.charts.rsi.addLineSeries({ color: 'rgba(248,81,73,0.4)', lineWidth: 1, lineStyle: 2, priceLineVisible: false });
  rsi70.setData([{ time: data.candles[0].time, value: 70 }, { time: data.candles[data.candles.length - 1].time, value: 70 }]);
  const rsi30 = state.charts.rsi.addLineSeries({ color: 'rgba(63,185,80,0.4)', lineWidth: 1, lineStyle: 2, priceLineVisible: false });
  rsi30.setData([{ time: data.candles[0].time, value: 30 }, { time: data.candles[data.candles.length - 1].time, value: 30 }]);
  state.series.rsi = rsiSeries;

  // MACD chart
  state.charts.macd = LightweightCharts.createChart(macdC, { ...chartOptions, height: 120 });
  const macdVals = calcMACD(data.candles.map(c => c.close));
  const times = data.candles.map(c => c.time);

  const macdLine = state.charts.macd.addLineSeries({ color: '#0ea5e9', lineWidth: 1.5, priceLineVisible: false });
  macdLine.setData(times.map((t, i) => macdVals.macd[i] !== null ? { time: t, value: macdVals.macd[i] } : null).filter(Boolean));

  const sigLine = state.charts.macd.addLineSeries({ color: '#e3a012', lineWidth: 1, lineStyle: 0, priceLineVisible: false });
  sigLine.setData(times.map((t, i) => macdVals.signal[i] !== null ? { time: t, value: macdVals.signal[i] } : null).filter(Boolean));

  const histSeries = state.charts.macd.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
  histSeries.setData(times.map((t, i) => {
    if (macdVals.histogram[i] === null) return null;
    return { time: t, value: macdVals.histogram[i], color: macdVals.histogram[i] >= 0 ? 'rgba(63,185,80,0.6)' : 'rgba(248,81,73,0.6)' };
  }).filter(Boolean));

  // Sync crosshair
  const syncCross = (chart, others) => {
    chart.subscribeCrosshairMove(p => {
      if (!p.time) return;
      others.forEach(o => o?.setCrosshairPosition(p.seriesPrices?.values()?.next()?.value ?? 0, p.time, o.series?.[0]));
    });
  };

  state.charts.main.timeScale().subscribeVisibleLogicalRangeChange(r => {
    if (r) {
      state.charts.rsi.timeScale().setVisibleLogicalRange(r);
      state.charts.macd.timeScale().setVisibleLogicalRange(r);
    }
  });

  state.charts.main.timeScale().fitContent();
  document.getElementById('rsiPanel').style.display = 'block';
  document.getElementById('macdPanel').style.display = 'block';
}

function renderOverlays(data) {
  if (!state.charts.main) return;
  const closes = data.candles.map(c => c.close);
  const times = data.candles.map(c => c.time);

  // Remove old overlay series
  ['sma20s', 'sma50s', 'sma200s', 'ema12s', 'ema26s', 'bbUpper', 'bbMiddle', 'bbLower'].forEach(k => {
    if (state.series[k]) {
      try { state.charts.main.removeSeries(state.series[k]); } catch {}
      delete state.series[k];
    }
  });

  const addLine = (key, color, lineWidth = 1, lineStyle = 0, dashes = false) => {
    const s = state.charts.main.addLineSeries({
      color, lineWidth, lineStyle: dashes ? 2 : lineStyle,
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false
    });
    state.series[key] = s;
    return s;
  };

  if (state.indicators.sma20) {
    const sma = calcSMA(closes, 20);
    addLine('sma20s', '#d29922', 1).setData(times.map((t, i) => sma[i] !== null ? { time: t, value: sma[i] } : null).filter(Boolean));
  }

  if (state.indicators.sma50) {
    const sma = calcSMA(closes, 50);
    addLine('sma50s', '#0ea5e9', 1.5).setData(times.map((t, i) => sma[i] !== null ? { time: t, value: sma[i] } : null).filter(Boolean));
  }

  if (state.indicators.sma200) {
    const sma = calcSMA(closes, 200);
    addLine('sma200s', '#f85149', 1.5, 0, true).setData(times.map((t, i) => sma[i] !== null ? { time: t, value: sma[i] } : null).filter(Boolean));
  }

  if (state.indicators.ema) {
    const ema12 = calcEMA(closes, 12);
    const ema26 = calcEMA(closes, 26);
    addLine('ema12s', 'rgba(63,185,80,0.8)', 1).setData(times.map((t, i) => ema12[i] !== null ? { time: t, value: ema12[i] } : null).filter(Boolean));
    addLine('ema26s', 'rgba(227,160,18,0.8)', 1).setData(times.map((t, i) => ema26[i] !== null ? { time: t, value: ema26[i] } : null).filter(Boolean));
  }

  if (state.indicators.bb) {
    const bb = calcBollingerBands(closes, 20, 2);
    const u = addLine('bbUpper', 'rgba(137,87,229,0.6)', 1);
    const m = addLine('bbMiddle', 'rgba(137,87,229,0.3)', 1, 2);
    const l = addLine('bbLower', 'rgba(137,87,229,0.6)', 1);
    u.setData(times.map((t, i) => bb.upper[i] !== null ? { time: t, value: bb.upper[i] } : null).filter(Boolean));
    m.setData(times.map((t, i) => bb.middle[i] !== null ? { time: t, value: bb.middle[i] } : null).filter(Boolean));
    l.setData(times.map((t, i) => bb.lower[i] !== null ? { time: t, value: bb.lower[i] } : null).filter(Boolean));
  }
}

/* ════════════════════════════════════
   STOCK HEADER
════════════════════════════════════ */
function showStockHeader(symbol, data) {
  const header = document.getElementById('stockHeader');
  header.style.display = 'flex';
  document.getElementById('stockSymbol').textContent = symbol;
  document.getElementById('stockName').textContent = SYMBOL_DB[symbol] || '';
  document.getElementById('stockPrice').textContent = '—';
  document.getElementById('stockChange').textContent = '';
  document.getElementById('stockPct').textContent = '';
}

function updateStockHeader(data) {
  const { candles, symbol, exchange } = data;
  if (!candles.length) return;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const price = last.close;
  const prevClose = data.previousClose || (prev ? prev.close : price);
  const change = price - prevClose;
  const pct = (change / prevClose) * 100;
  const up = change >= 0;

  document.getElementById('stockSymbol').textContent = symbol;
  document.getElementById('stockExchange').textContent = exchange;
  document.getElementById('stockPrice').textContent = `$${fmtNum(price)}`;

  const chgEl = document.getElementById('stockChange');
  chgEl.textContent = `${up ? '+' : ''}${fmtNum(change)}`;
  chgEl.className = `stock-change ${up ? 'up' : 'down'}`;

  const pctEl = document.getElementById('stockPct');
  pctEl.textContent = `(${up ? '+' : ''}${fmtNum(pct, 2)}%)`;
  pctEl.className = `stock-pct ${up ? 'up' : 'down'}`;

  // 52W range from chart data
  const allHighs = candles.map(c => c.high);
  const allLows = candles.map(c => c.low);
  const h52 = Math.max(...allHighs);
  const l52 = Math.min(...allLows);
  const totalVol = candles.reduce((s, c) => s + (c.volume || 0), 0);
  const avgVol = totalVol / candles.length;

  document.getElementById('meta52High').textContent = `$${fmtNum(h52)}`;
  document.getElementById('meta52Low').textContent = `$${fmtNum(l52)}`;
  document.getElementById('metaVolume').textContent = fmtVolume(last.volume);
  document.getElementById('metaAvgVol').textContent = fmtVolume(Math.round(avgVol));
}

/* ════════════════════════════════════
   SIGNAL PANEL
════════════════════════════════════ */
function renderSignalPanel(data) {
  const { candles } = data;
  if (candles.length < 30) return;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const result = generateSignals(closes, highs, lows);

  const card = document.getElementById('signalCard');
  card.style.display = 'block';

  const pill = document.getElementById('verdictPill');
  pill.textContent = result.verdict;
  pill.className = `verdict-pill ${result.verdictClass}`;
  document.getElementById('verdictScore').textContent = `Score: ${result.score > 0 ? '+' : ''}${result.score.toFixed(1)}`;

  const list = document.getElementById('signalList');
  list.innerHTML = '';
  result.signals.forEach(s => {
    const row = document.createElement('div');
    row.className = `signal-row ${s.dir}`;
    row.innerHTML = `
      <span class="signal-name">${s.name}</span>
      <span class="signal-text">${s.text}</span>
      <span class="signal-value">${s.value}</span>
    `;
    list.appendChild(row);
  });
}

/* ════════════════════════════════════
   FUNDAMENTALS PANEL
════════════════════════════════════ */
function renderFundamentals(s) {
  const card = document.getElementById('fundamentalsCard');
  card.style.display = 'block';

  const grid = document.getElementById('fundamentalsGrid');
  const items = [
    { label: 'P/E Ratio', value: s.pe ? fmtNum(s.pe, 1) : '—', sub: s.forwardPE ? `Fwd: ${fmtNum(s.forwardPE, 1)}` : '' },
    { label: 'EPS (TTM)', value: s.eps ? `$${fmtNum(s.eps, 2)}` : '—', sub: '' },
    { label: 'Market Cap', value: fmtLargeNum(s.marketCap), sub: '' },
    { label: 'Revenue', value: fmtLargeNum(s.totalRevenue), sub: s.revenueGrowth ? fmtPct(s.revenueGrowth) + ' YoY' : '' },
    { label: 'Profit Margin', value: s.profitMargin ? fmtPct(s.profitMargin) : '—', sub: '', cls: s.profitMargin > 0.15 ? 'positive' : s.profitMargin < 0 ? 'negative' : '' },
    { label: 'Return on Equity', value: s.returnOnEquity ? fmtPct(s.returnOnEquity) : '—', sub: '', cls: s.returnOnEquity > 0.15 ? 'positive' : s.returnOnEquity < 0 ? 'negative' : '' },
    { label: 'Beta', value: s.beta ? fmtNum(s.beta, 2) : '—', sub: s.beta > 1.5 ? 'High volatility' : s.beta < 0.5 ? 'Low volatility' : '' },
    { label: 'Div. Yield', value: s.dividendYield ? fmtPct(s.dividendYield) : 'N/A', sub: '' },
    { label: 'P/B Ratio', value: s.priceToBook ? fmtNum(s.priceToBook, 2) : '—', sub: '' },
    { label: 'Debt/Equity', value: s.debtToEquity ? fmtNum(s.debtToEquity / 100, 2) : '—', sub: '', cls: s.debtToEquity > 200 ? 'negative' : s.debtToEquity < 50 ? 'positive' : '' },
    { label: 'Free Cash Flow', value: fmtLargeNum(s.freeCashFlow), sub: '' },
    { label: 'Analyst Target', value: s.targetMeanPrice ? `$${fmtNum(s.targetMeanPrice)}` : '—', sub: s.recommendationKey ? s.recommendationKey.replace(/_/g,' ').toUpperCase() : '' }
  ];

  grid.innerHTML = items.map(i => `
    <div class="fund-item">
      <span class="fund-label">${i.label}</span>
      <span class="fund-value${i.cls ? ' ' + i.cls : ''}">${i.value}</span>
      ${i.sub ? `<span class="fund-sub">${i.sub}</span>` : ''}
    </div>
  `).join('');
}

function renderAbout(s) {
  if (!s.summary && !s.sector) return;
  const card = document.getElementById('aboutCard');
  card.style.display = 'block';

  if (s.summary) {
    const sumEl = document.getElementById('aboutSummary');
    const text = s.summary.length > 320 ? s.summary.slice(0, 317) + '…' : s.summary;
    sumEl.textContent = text;
  }

  const tags = document.getElementById('aboutTags');
  const tagList = [s.sector, s.industry, s.country, s.city, s.employees ? `${(s.employees / 1000).toFixed(0)}K employees` : null]
    .filter(Boolean);
  tags.innerHTML = tagList.map(t => `<span class="about-tag">${t}</span>`).join('');
}

/* ════════════════════════════════════
   STRATEGIES
════════════════════════════════════ */
function analyzeStrategy(strategyId) {
  const symbolMap = {
    'golden-cross': 'SPY',
    'rsi-reversal': 'AAPL',
    'macd-momentum': 'NVDA',
    'bollinger-squeeze': 'TSLA',
    'relative-strength': 'MSFT'
  };
  const sym = symbolMap[strategyId] || 'SPY';
  switchTab('analyze');
  analyzeSymbol(sym);
}

/* ════════════════════════════════════
   SCREENER
════════════════════════════════════ */
function initScreener() {
  document.getElementById('runScreener')?.addEventListener('click', runScreener);
  document.getElementById('resetScreener')?.addEventListener('click', resetScreener);
  document.getElementById('sortBy')?.addEventListener('change', runScreener);

  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });
}

async function loadScreenerPrices() {
  const syms = state.screenerData.map(s => s.symbol);
  const chunks = [];
  for (let i = 0; i < syms.length; i += 20) chunks.push(syms.slice(i, i + 20));

  for (const chunk of chunks) {
    try {
      const quotes = await fetchMultiQuote(chunk);
      quotes.forEach(q => {
        const row = state.screenerData.find(r => r.symbol === q.symbol);
        if (row) {
          row.price = q.price || 0;
          row.changePct = q.changePct || 0;
          row.mktCap = q.marketCap || row.mktCap;
          row.pe = q.pe || row.pe;
        }
      });
    } catch {}
  }
  renderScreenerTable(state.screenerData);
}

function runScreener() {
  const sector = document.getElementById('filterSector').value;
  const mktCapFilter = document.getElementById('filterMktCap').value;
  const peMin = parseFloat(document.getElementById('filterPeMin').value) || null;
  const peMax = parseFloat(document.getElementById('filterPeMax').value) || null;
  const chgMin = parseFloat(document.getElementById('filterChgMin').value) || null;
  const chgMax = parseFloat(document.getElementById('filterChgMax').value) || null;
  const priceMin = parseFloat(document.getElementById('filterPriceMin').value) || null;
  const priceMax = parseFloat(document.getElementById('filterPriceMax').value) || null;
  const signal = document.getElementById('filterSignal').value;
  const sortBy = document.getElementById('sortBy').value;

  let filtered = state.screenerData.filter(row => {
    if (sector && row.sector !== sector) return false;
    if (mktCapFilter) {
      const mc = row.mktCap;
      if (mktCapFilter === 'mega' && mc < 200e9) return false;
      if (mktCapFilter === 'large' && (mc < 10e9 || mc >= 200e9)) return false;
      if (mktCapFilter === 'mid' && (mc < 2e9 || mc >= 10e9)) return false;
      if (mktCapFilter === 'small' && (mc < 300e6 || mc >= 2e9)) return false;
    }
    if (peMin !== null && (row.pe === null || row.pe < peMin)) return false;
    if (peMax !== null && (row.pe === null || row.pe > peMax)) return false;
    if (chgMin !== null && row.changePct < chgMin) return false;
    if (chgMax !== null && row.changePct > chgMax) return false;
    if (priceMin !== null && row.price < priceMin) return false;
    if (priceMax !== null && row.price > priceMax) return false;
    if (signal && row.signal !== signal) return false;
    return true;
  });

  // Sort
  filtered.sort((a, b) => {
    if (sortBy === 'mktCap') return (b.mktCap || 0) - (a.mktCap || 0);
    if (sortBy === 'change') return (b.changePct || 0) - (a.changePct || 0);
    if (sortBy === 'pe') return (a.pe || 999) - (b.pe || 999);
    if (sortBy === 'price') return (b.price || 0) - (a.price || 0);
    return 0;
  });

  document.getElementById('screenerCount').textContent = `${filtered.length} results`;
  renderScreenerTable(filtered);
}

function renderScreenerTable(rows) {
  const tbody = document.getElementById('screenerBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="table-loading">No stocks match your filters</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(row => {
    const up = (row.changePct || 0) >= 0;
    const signalBadge = getSignalBadge(row.signal);
    return `
      <tr>
        <td class="td-symbol">${row.symbol}</td>
        <td>${row.name}</td>
        <td>${row.sector}</td>
        <td>${row.price ? '$' + fmtNum(row.price) : '—'}</td>
        <td class="${up ? 'td-up' : 'td-down'}">${up ? '+' : ''}${(row.changePct || 0).toFixed(2)}%</td>
        <td>${fmtLargeNum(row.mktCap)}</td>
        <td>${row.pe ? fmtNum(row.pe, 1) : '—'}</td>
        <td class="${row.epsGrowth >= 0.15 ? 'td-up' : row.epsGrowth < 0 ? 'td-down' : ''}">${row.epsGrowth !== undefined ? fmtPct(row.epsGrowth) : '—'}</td>
        <td>${signalBadge}</td>
        <td><button class="analyze-link" onclick="analyzeSymbol('${row.symbol}');switchTab('analyze')">Analyze →</button></td>
      </tr>
    `;
  }).join('');
}

function getSignalBadge(signal) {
  const map = {
    'Strong Buy': 'strong-buy',
    'Buy': 'buy',
    'Neutral': 'neutral',
    'Sell': 'sell',
    'Strong Sell': 'strong-sell',
    '—': 'neutral'
  };
  const cls = map[signal] || 'neutral';
  return `<span class="signal-badge badge-${cls}">${signal || '—'}</span>`;
}

function resetScreener() {
  document.getElementById('filterSector').value = '';
  document.getElementById('filterMktCap').value = '';
  document.getElementById('filterPeMin').value = '';
  document.getElementById('filterPeMax').value = '';
  document.getElementById('filterChgMin').value = '';
  document.getElementById('filterChgMax').value = '';
  document.getElementById('filterPriceMin').value = '';
  document.getElementById('filterPriceMax').value = '';
  document.getElementById('filterSignal').value = '';
  renderScreenerTable(state.screenerData);
  document.getElementById('screenerCount').textContent = `${state.screenerData.length} results`;
}

function applyPreset(preset) {
  resetScreener();
  const presets = {
    momentum: () => {
      document.getElementById('filterChgMin').value = '1';
      document.getElementById('filterMktCap').value = 'large';
    },
    value: () => {
      document.getElementById('filterPeMin').value = '8';
      document.getElementById('filterPeMax').value = '20';
      document.getElementById('filterMktCap').value = 'large';
    },
    oversold: () => {
      document.getElementById('filterChgMin').value = '-5';
      document.getElementById('filterChgMax').value = '-1';
    },
    growth: () => {
      document.getElementById('filterSector').value = 'Technology';
      document.getElementById('filterPeMin').value = '20';
    }
  };
  presets[preset]?.();
  runScreener();
}

/* ════════════════════════════════════
   INITIAL SCREENER TABLE RENDER
════════════════════════════════════ */
(function initScreenerTable() {
  const tbody = document.getElementById('screenerBody');
  if (!tbody) return;
  renderScreenerTable(SCREENER_STOCKS);
  document.getElementById('screenerCount').textContent = `${SCREENER_STOCKS.length} results`;
})();
