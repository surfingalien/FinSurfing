/* ═══════════════════════════════════════════════
   FinSurf — Technical Indicator Calculations
   Pure functions, no dependencies
═══════════════════════════════════════════════ */

function calcSMA(data, period) {
  const out = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    out[i] = sum / period;
  }
  return out;
}

function calcEMA(data, period) {
  const out = new Array(data.length).fill(null);
  const k = 2 / (period + 1);
  let started = false;
  let ema = 0;
  let count = 0;
  let sumInit = 0;

  for (let i = 0; i < data.length; i++) {
    if (!started) {
      sumInit += data[i];
      count++;
      if (count === period) {
        ema = sumInit / period;
        out[i] = ema;
        started = true;
      }
    } else {
      ema = data[i] * k + ema * (1 - k);
      out[i] = ema;
    }
  }
  return out;
}

function calcRSI(data, period = 14) {
  const out = new Array(data.length).fill(null);
  if (data.length <= period) return out;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = data[i] - data[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  out[period] = 100 - 100 / (1 + rs);

  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs2 = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out[i] = 100 - 100 / (1 + rs2);
  }
  return out;
}

function calcMACD(data, fast = 12, slow = 26, sig = 9) {
  const emaFast = calcEMA(data, fast);
  const emaSlow = calcEMA(data, slow);

  const macdLine = data.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
  );

  // Build dense array for signal EMA calculation
  const startIdx = macdLine.findIndex(v => v !== null);
  const dense = macdLine.slice(startIdx).filter(v => v !== null);
  const sigEMA = calcEMA(dense, sig);

  // Map signal back to full-length array
  const signalLine = new Array(data.length).fill(null);
  let di = 0;
  for (let i = startIdx; i < data.length; i++) {
    if (macdLine[i] !== null) {
      signalLine[i] = sigEMA[di] !== undefined ? sigEMA[di] : null;
      di++;
    }
  }

  const histogram = data.map((_, i) =>
    macdLine[i] !== null && signalLine[i] !== null
      ? macdLine[i] - signalLine[i]
      : null
  );

  return { macd: macdLine, signal: signalLine, histogram };
}

function calcBollingerBands(data, period = 20, stdMult = 2) {
  const sma = calcSMA(data, period);
  const upper = new Array(data.length).fill(null);
  const lower = new Array(data.length).fill(null);

  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1);
    const mean = sma[i];
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    upper[i] = mean + stdMult * std;
    lower[i] = mean - stdMult * std;
  }

  return { upper, middle: sma, lower };
}

function calcATR(highs, lows, closes, period = 14) {
  const tr = [];
  for (let i = 0; i < highs.length; i++) {
    if (i === 0) { tr.push(highs[i] - lows[i]); continue; }
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  return calcSMA(tr, period);
}

function generateSignals(closes, highs, lows) {
  const rsi = calcRSI(closes);
  const macd = calcMACD(closes);
  const sma20 = calcSMA(closes, 20);
  const sma50 = calcSMA(closes, 50);
  const sma200 = calcSMA(closes, 200);
  const bb = calcBollingerBands(closes);
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);

  const n = closes.length - 1;
  const price = closes[n];
  const signals = [];
  let score = 0;

  // RSI
  const rsiVal = rsi[n];
  if (rsiVal !== null) {
    if (rsiVal < 25) {
      signals.push({ name: 'RSI', text: 'Strongly Oversold', value: rsiVal.toFixed(1), dir: 'bullish' });
      score += 2;
    } else if (rsiVal < 35) {
      signals.push({ name: 'RSI', text: 'Oversold — potential buy', value: rsiVal.toFixed(1), dir: 'bullish' });
      score += 1;
    } else if (rsiVal > 75) {
      signals.push({ name: 'RSI', text: 'Strongly Overbought', value: rsiVal.toFixed(1), dir: 'bearish' });
      score -= 2;
    } else if (rsiVal > 65) {
      signals.push({ name: 'RSI', text: 'Overbought — caution', value: rsiVal.toFixed(1), dir: 'bearish' });
      score -= 1;
    } else if (rsiVal > 55) {
      signals.push({ name: 'RSI', text: 'Bullish momentum', value: rsiVal.toFixed(1), dir: 'bullish' });
      score += 0.5;
    } else if (rsiVal < 45) {
      signals.push({ name: 'RSI', text: 'Bearish momentum', value: rsiVal.toFixed(1), dir: 'bearish' });
      score -= 0.5;
    } else {
      signals.push({ name: 'RSI', text: 'Neutral zone', value: rsiVal.toFixed(1), dir: 'neutral' });
    }
  }

  // MACD
  const macdVal = macd.macd[n];
  const sigVal = macd.signal[n];
  const macdPrev = macd.macd[n - 1];
  const sigPrev = macd.signal[n - 1];
  if (macdVal !== null && sigVal !== null) {
    const crossedUp = macdPrev !== null && sigPrev !== null && macdPrev <= sigPrev && macdVal > sigVal;
    const crossedDown = macdPrev !== null && sigPrev !== null && macdPrev >= sigPrev && macdVal < sigVal;
    if (crossedUp) {
      signals.push({ name: 'MACD', text: 'Bullish crossover ↑', value: macdVal.toFixed(3), dir: 'bullish' });
      score += 2;
    } else if (crossedDown) {
      signals.push({ name: 'MACD', text: 'Bearish crossover ↓', value: macdVal.toFixed(3), dir: 'bearish' });
      score -= 2;
    } else if (macdVal > sigVal && macdVal > 0) {
      signals.push({ name: 'MACD', text: 'Bullish (above zero)', value: macdVal.toFixed(3), dir: 'bullish' });
      score += 1;
    } else if (macdVal > sigVal) {
      signals.push({ name: 'MACD', text: 'Mildly bullish', value: macdVal.toFixed(3), dir: 'bullish' });
      score += 0.5;
    } else if (macdVal < sigVal && macdVal < 0) {
      signals.push({ name: 'MACD', text: 'Bearish (below zero)', value: macdVal.toFixed(3), dir: 'bearish' });
      score -= 1;
    } else {
      signals.push({ name: 'MACD', text: 'Mildly bearish', value: macdVal.toFixed(3), dir: 'bearish' });
      score -= 0.5;
    }
  }

  // SMA50 vs SMA200 — trend
  if (sma50[n] !== null && sma200[n] !== null) {
    const prevS50 = sma50[n - 5];
    const prevS200 = sma200[n - 5];
    if (sma50[n] > sma200[n] && prevS50 !== null && prevS50 <= prevS200) {
      signals.push({ name: 'MA Cross', text: 'Golden Cross (strong bull)', value: `50>${sma200[n].toFixed(0)}`, dir: 'bullish' });
      score += 3;
    } else if (sma50[n] < sma200[n] && prevS50 !== null && prevS50 >= prevS200) {
      signals.push({ name: 'MA Cross', text: 'Death Cross (strong bear)', value: `50<${sma200[n].toFixed(0)}`, dir: 'bearish' });
      score -= 3;
    } else if (sma50[n] > sma200[n]) {
      signals.push({ name: 'MA Trend', text: 'SMA50 above SMA200 (uptrend)', value: `Δ${((sma50[n]/sma200[n]-1)*100).toFixed(1)}%`, dir: 'bullish' });
      score += 1;
    } else {
      signals.push({ name: 'MA Trend', text: 'SMA50 below SMA200 (downtrend)', value: `Δ${((sma50[n]/sma200[n]-1)*100).toFixed(1)}%`, dir: 'bearish' });
      score -= 1;
    }
  }

  // Price vs SMA50
  if (sma50[n] !== null) {
    if (price > sma50[n]) {
      signals.push({ name: 'SMA50', text: 'Price above SMA50', value: `$${sma50[n].toFixed(2)}`, dir: 'bullish' });
      score += 0.5;
    } else {
      signals.push({ name: 'SMA50', text: 'Price below SMA50', value: `$${sma50[n].toFixed(2)}`, dir: 'bearish' });
      score -= 0.5;
    }
  }

  // Bollinger Bands
  if (bb.upper[n] !== null && bb.lower[n] !== null) {
    const range = bb.upper[n] - bb.lower[n];
    const bbPos = range > 0 ? (price - bb.lower[n]) / range : 0.5;
    if (bbPos < 0.05) {
      signals.push({ name: 'Bollinger', text: 'At lower band — oversold', value: `${(bbPos * 100).toFixed(0)}% pos`, dir: 'bullish' });
      score += 1.5;
    } else if (bbPos < 0.15) {
      signals.push({ name: 'Bollinger', text: 'Near lower band', value: `${(bbPos * 100).toFixed(0)}% pos`, dir: 'bullish' });
      score += 0.5;
    } else if (bbPos > 0.95) {
      signals.push({ name: 'Bollinger', text: 'At upper band — overbought', value: `${(bbPos * 100).toFixed(0)}% pos`, dir: 'bearish' });
      score -= 1.5;
    } else if (bbPos > 0.85) {
      signals.push({ name: 'Bollinger', text: 'Near upper band', value: `${(bbPos * 100).toFixed(0)}% pos`, dir: 'bearish' });
      score -= 0.5;
    } else {
      signals.push({ name: 'Bollinger', text: `Mid band (${(bbPos * 100).toFixed(0)}% of range)`, value: `W:${range.toFixed(2)}`, dir: 'neutral' });
    }
  }

  // EMA trend
  if (ema12[n] !== null && ema26[n] !== null) {
    if (ema12[n] > ema26[n]) {
      signals.push({ name: 'EMA Trend', text: 'EMA12 above EMA26', value: `Δ${((ema12[n]/ema26[n]-1)*100).toFixed(2)}%`, dir: 'bullish' });
      score += 0.5;
    } else {
      signals.push({ name: 'EMA Trend', text: 'EMA12 below EMA26', value: `Δ${((ema12[n]/ema26[n]-1)*100).toFixed(2)}%`, dir: 'bearish' });
      score -= 0.5;
    }
  }

  // Verdict
  let verdict, verdictClass;
  if (score >= 4) { verdict = 'Strong Buy'; verdictClass = 'strong-buy'; }
  else if (score >= 2) { verdict = 'Buy'; verdictClass = 'buy'; }
  else if (score >= -1) { verdict = 'Neutral'; verdictClass = 'neutral'; }
  else if (score >= -3) { verdict = 'Sell'; verdictClass = 'sell'; }
  else { verdict = 'Strong Sell'; verdictClass = 'strong-sell'; }

  return { signals, score, verdict, verdictClass };
}

// Format numbers for display
function fmtNum(n, decimals = 2) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtLargeNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (Math.abs(n) >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  return '$' + n.toLocaleString();
}

function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const v = n * 100;
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

function fmtVolume(n) {
  if (!n) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}
