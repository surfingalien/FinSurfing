# Forecast comparison harness — Kronos vs TimesFM

Decides with numbers whether [Kronos](https://github.com/shiyu-coder/Kronos) (a
financial K-line foundation model, MIT) is worth putting in the forecast path
instead of — or alongside — the TimesFM model this service runs today.

It answers one question: **on our data, does either model forecast better than
assuming nothing happens?** On financial series that "naive" bar is genuinely
hard to clear, and a model that doesn't clear it has no business sizing a trade.

## Why this comparison is worth running

- TimesFM is **general-purpose and univariate** — it sees closing prices only.
- Kronos is **domain-specific and multivariate** — trained on OHLCV K-lines
  from 45+ exchanges, so it sees the highs, lows, and volume that TimesFM throws away.
- Both are PyTorch, and this service already pays the torch dependency cost.

That makes it a contained experiment, not a migration.

## Running it

```bash
cd timesfm_service

# 1. Plumbing check — no model weights, no torch needed
python -m bench.run --synthetic --models naive,drift

# 2. Confirm an adapter matches its installed package BEFORE trusting numbers
python -m bench.run --csv data/BTC-USD-1d.csv --models kronos --self-check

# 3. The real comparison
python -m bench.run --csv data/BTC-USD-1d.csv \
    --models naive,drift,timesfm,kronos \
    --context 512 --horizon 30 --stride 5 --max-origins 50 \
    --json results/btc-30d.json
```

Input CSV needs `timestamp,open,high,low,close,volume` (common aliases like
`Date` / `Adj Close` are accepted). Rows are sorted oldest → newest on load.

### Installing the models

Deliberately **not** in `bench/requirements.txt`, so a run never silently pulls
~2 GB of torch you didn't ask for:

```bash
# TimesFM — already in ../requirements.txt
pip install "timesfm[torch]>=2.5.0"

# Kronos — source checkout; its `model` package isn't on PyPI
git clone https://github.com/shiyu-coder/Kronos
pip install -r Kronos/requirements.txt
export PYTHONPATH=/path/to/Kronos:$PYTHONPATH
```

Start with `Kronos-small`; `--models kronos:NeoQuasar/Kronos-base` selects a
larger checkpoint. On CPU, expect Kronos to be slow — it's autoregressive and
samples. Use `--max-origins` to keep runs bounded.

## How it scores

**Walk-forward, no lookahead.** For each origin `i`, the model sees rows
`[i-context, i)` and is scored against `[i, i+horizon)`. No row is ever in
both — that property is directly tested (`test_context_and_actuals_never_overlap`).

| Metric | What it's for |
|---|---|
| MAPE / sMAPE | Scale-free error, comparable across symbols. sMAPE is bounded so one blow-up can't dominate. |
| RMSE | Punishes concentrated errors more than MAE. |
| **Directional accuracy** | The number that matters for entries: from the last observed price, did it call up/down right? |
| sec/forecast | Inference cost — a model too slow for the request path is academic. |

Reported per-horizon (1d / 7d / 30d) as well as overall, because a model can be
useful at one horizon and useless at another.

**Two baselines, both mandatory:**
- `naive-last` — last close held flat (random walk). The bar.
- `naive-drift` — extends recent trend. Catches a model that's only doing that.

A flat forecast **abstains** from calling direction rather than scoring 0% —
otherwise naive looks catastrophically bad at direction and flatters every rival
by ~50 points. Directional skill is therefore judged against a **coin flip (50%)**,
not against naive.

## Reading the result

Adopt Kronos only if it **beats `naive-last` on MAPE _and_ holds >50% directional
accuracy** at the horizon you'd actually trade. If it only wins on MAPE while
calling direction at chance, it's a better curve-fitter, not a better signal.

**Accuracy is not profitability.** Clearing this bar earns a model a place in the
forecast path — it does not prove it makes money. Fees, slippage, and position
sizing all come after, and they routinely erase a statistical edge this harness
would happily report.

## Status

- Metrics, walk-forward slicing, loader, and baselines: **tested** (`pytest bench/tests/`, 22 tests).
- `TimesFMForecaster` mirrors the model/compile settings in `../main.py` but was
  **not executed** against real weights here.
- `KronosForecaster` was written from Kronos's documented `KronosPredictor` API and
  is **unverified against the installed package** — run `--self-check` first. If the
  API has moved, `bench/adapters.py` is the only file that needs changing.
