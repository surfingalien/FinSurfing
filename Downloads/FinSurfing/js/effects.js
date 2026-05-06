/* ═══════════════════════════════════════════════
   FinSurf — Visual Effects & Animation Layer
   Runs after app.js is fully initialised
═══════════════════════════════════════════════ */

/* ────────────────────────────────────
   Number counter animation
───────────────────────────────────── */
function animateValue(el, from, to, duration = 700, decimals = 2) {
  if (!el || isNaN(to)) return;
  const start = performance.now();
  const prefix = to >= 0 ? '' : '-';
  const absFrom = Math.abs(from);
  const absTo   = Math.abs(to);

  function tick(now) {
    const elapsed = Math.min(now - start, duration);
    const t = 1 - Math.pow(1 - elapsed / duration, 3); // ease-out-cubic
    const current = absFrom + (absTo - absFrom) * t;
    el.textContent = (to < 0 ? '-' : '') + current.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
    if (elapsed < duration) requestAnimationFrame(tick);
    else el.textContent = to.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  requestAnimationFrame(tick);
}

/* ────────────────────────────────────
   Flash element on data change
───────────────────────────────────── */
function flashEl(el, up) {
  if (!el) return;
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth; // reflow
  el.classList.add(up ? 'flash-up' : 'flash-down');
  el.addEventListener('animationend', () => el.classList.remove('flash-up', 'flash-down'), { once: true });
}

/* ────────────────────────────────────
   Hero stats — update with animation
───────────────────────────────────── */
function updateHeroStats(quotes) {
  const spy = quotes.find(q => q.symbol === 'SPY');
  const qqq = quotes.find(q => q.symbol === 'QQQ');
  const vix = quotes.find(q => q.symbol === '%5EVIX') || quotes.find(q => q.symbol === '^VIX');

  function setHeroStat(id, q) {
    const el = document.getElementById(id);
    if (!el || !q) return;
    const prev = parseFloat(el.dataset.prev || q.price);
    const up = q.price >= prev;
    el.dataset.prev = q.price;

    el.classList.remove('up', 'down');
    el.classList.add(up ? 'up' : 'down');
    animateValue(el, prev, q.price, 800, 2);
  }

  setHeroStat('heroSpyPrice',    spy);
  setHeroStat('heroNasdaqPrice', qqq);
  setHeroStat('heroVixPrice',    vix);
}

/* ────────────────────────────────────
   Intercept loadIndices to also update hero
───────────────────────────────────── */
const _origFetchMultiQuote = window.fetchMultiQuote;

// Patch: after loadOverview runs, hook hero stats into the indices data
const _origLoadIndices = window.loadIndices;
if (typeof _origLoadIndices === 'function') {
  // Already defined — wrap it
  window.loadIndices = async function () {
    await _origLoadIndices();
    // Hero stats fed by re-fetching (cached, so free)
    try {
      const q = await fetchMultiQuote(['SPY', 'QQQ', '^VIX']);
      updateHeroStats(q);
    } catch {}
  };
}

/* ────────────────────────────────────
   Mark chart cards as "loaded" for glow border
───────────────────────────────────── */
(function patchInitCharts() {
  const orig = window.initCharts;
  if (typeof orig !== 'function') return;
  window.initCharts = function (data) {
    orig(data);
    document.querySelectorAll('.chart-card').forEach(el => {
      setTimeout(() => el.classList.add('loaded'), 400);
    });
  };
})();

/* ────────────────────────────────────
   Index card price — animate in on update
───────────────────────────────────── */
(function observeIndexPrices() {
  const observer = new MutationObserver(mutations => {
    mutations.forEach(m => {
      if (m.type === 'characterData' || m.type === 'childList') {
        const el = m.target.nodeType === 3 ? m.target.parentElement : m.target;
        if (el && el.classList.contains('index-price')) {
          const card = el.closest('.index-card');
          if (card) flashEl(card, card.classList.contains('up'));
        }
      }
    });
  });

  document.querySelectorAll('.index-price').forEach(el => {
    observer.observe(el, { characterData: true, childList: true, subtree: true });
  });
})();

/* ────────────────────────────────────
   Tab switch — re-trigger stagger animations
───────────────────────────────────── */
(function patchSwitchTab() {
  const orig = window.switchTab;
  if (typeof orig !== 'function') return;
  window.switchTab = function (tab) {
    orig(tab);
    // Reflow trick so CSS animations replay
    const panel = document.getElementById(`tab-${tab}`);
    if (panel) {
      panel.querySelectorAll('.strategy-card, .learn-card, .index-card').forEach(el => {
        el.style.animationName = 'none';
        void el.offsetWidth;
        el.style.animationName = '';
      });
    }
  };
})();

/* ────────────────────────────────────
   Stock price update flash
   Patch updateStockHeader to flash on change
───────────────────────────────────── */
(function patchStockHeader() {
  const orig = window.updateStockHeader;
  if (typeof orig !== 'function') return;
  window.updateStockHeader = function (data) {
    const prevPrice = parseFloat(document.getElementById('stockPrice')?.textContent?.replace(/[$,]/g, '')) || 0;
    orig(data);
    const newPrice = data.candles?.[data.candles.length - 1]?.close;
    if (prevPrice && newPrice) {
      const priceEl = document.getElementById('stockPrice');
      flashEl(priceEl, newPrice >= prevPrice);
    }
  };
})();

/* ────────────────────────────────────
   Subtle scanline overlay (very low opacity)
───────────────────────────────────── */
(function addScanlines() {
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  Object.assign(el.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '1',
    pointerEvents: 'none',
    background: 'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.018) 3px, rgba(0,0,0,0.018) 4px)',
    mixBlendMode: 'multiply'
  });
  document.body.insertBefore(el, document.body.firstChild);
})();

/* ────────────────────────────────────
   Staggered table row reveal (screener / quick table)
───────────────────────────────────── */
function staggerTableRows(tbodyId) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  Array.from(tbody.querySelectorAll('tr')).forEach((tr, i) => {
    tr.style.opacity = '0';
    tr.style.transform = 'translateY(6px)';
    tr.style.transition = `opacity 0.3s ease ${i * 0.03}s, transform 0.3s ease ${i * 0.03}s`;
    requestAnimationFrame(() => {
      tr.style.opacity = '1';
      tr.style.transform = 'translateY(0)';
    });
  });
}

// Observe DOM changes to quick table and screener body
['quickTableBody', 'screenerBody'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  new MutationObserver(() => staggerTableRows(id)).observe(el, { childList: true });
});

/* ────────────────────────────────────
   Page load — hero entrance
───────────────────────────────────── */
window.addEventListener('load', () => {
  const hero = document.querySelector('.hero');
  if (hero) {
    hero.style.opacity = '0';
    hero.style.transform = 'translateY(12px)';
    hero.style.transition = 'opacity 0.7s cubic-bezier(0.16,1,0.3,1), transform 0.7s cubic-bezier(0.16,1,0.3,1)';
    requestAnimationFrame(() => {
      hero.style.opacity = '1';
      hero.style.transform = 'translateY(0)';
    });
  }
});

/* ────────────────────────────────────
   Tooltip on data cells (optional)
───────────────────────────────────── */
document.querySelectorAll('.fund-item').forEach(el => {
  el.style.cursor = 'default';
});

console.log('%cFinSurf Effects loaded ✦', 'color:#e3a012;font-family:monospace;font-weight:700;');
