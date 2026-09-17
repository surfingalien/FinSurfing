"""Forecast accuracy metrics.

Pure functions over numpy arrays — no model, no I/O — so the scoring the whole
comparison rests on is directly testable.

A note on which numbers matter. For a *trading* decision, scale-free error
(MAPE) and DIRECTIONAL accuracy are worth more than absolute error: a model
that predicts BTC within $50 but calls the direction wrong half the time is
useless for entries, while a model with larger absolute error that calls
direction 58% of the time may be tradeable. Absolute errors are reported
because they're comparable across models on the same series, not because
they're the decision criterion.
"""
from typing import Dict

import numpy as np


def _as_arrays(actual, predicted):
    a = np.asarray(actual, dtype=float).ravel()
    p = np.asarray(predicted, dtype=float).ravel()
    if a.shape != p.shape:
        raise ValueError(f"actual/predicted length mismatch: {a.shape} vs {p.shape}")
    if a.size == 0:
        raise ValueError("empty arrays")
    return a, p


def mae(actual, predicted) -> float:
    a, p = _as_arrays(actual, predicted)
    return float(np.mean(np.abs(a - p)))


def rmse(actual, predicted) -> float:
    a, p = _as_arrays(actual, predicted)
    return float(np.sqrt(np.mean((a - p) ** 2)))


def mape(actual, predicted) -> float:
    """Mean absolute percentage error, in percent. Zero actuals are dropped
    rather than producing infinities (prices shouldn't be zero, but a bad
    data feed shouldn't silently poison the whole comparison)."""
    a, p = _as_arrays(actual, predicted)
    mask = a != 0
    if not mask.any():
        return float("nan")
    return float(np.mean(np.abs((a[mask] - p[mask]) / a[mask])) * 100)


def smape(actual, predicted) -> float:
    """Symmetric MAPE, in percent. Bounded at 200%, so a single catastrophic
    prediction can't dominate the average the way MAPE lets it."""
    a, p = _as_arrays(actual, predicted)
    denom = (np.abs(a) + np.abs(p)) / 2
    mask = denom != 0
    if not mask.any():
        return float("nan")
    return float(np.mean(np.abs(a[mask] - p[mask]) / denom[mask]) * 100)


def directional_accuracy(actual, predicted, last_observed: float) -> float:
    """Fraction of horizons where the predicted direction from the last
    OBSERVED price matches the actual direction, in percent.

    Measured against last_observed (the final close of the context window),
    not against the previous predicted step — that's the call a trader
    actually acts on: "from here, is it going up or down?"

    Steps where the actual move is exactly flat are excluded: there is no
    direction to get right, and counting them would reward or punish noise.

    Steps where the PREDICTION is exactly flat are also excluded — that's an
    abstention, not a wrong call. Without this, a flat forecaster (naive-last)
    scores a structural 0%, which reads as "terrible at direction" when it
    actually made no directional claim, and makes every other model look
    better than it is by comparison. A forecaster that always abstains scores
    NaN, which the report shows as n/a.
    """
    a, p = _as_arrays(actual, predicted)
    actual_dir = np.sign(a - last_observed)
    pred_dir = np.sign(p - last_observed)
    scored = (actual_dir != 0) & (pred_dir != 0)
    if not scored.any():
        return float("nan")
    return float(np.mean(actual_dir[scored] == pred_dir[scored]) * 100)


def evaluate(actual, predicted, last_observed: float) -> Dict[str, float]:
    """All metrics for one (context → horizon) forecast."""
    return {
        "mae": mae(actual, predicted),
        "rmse": rmse(actual, predicted),
        "mape": mape(actual, predicted),
        "smape": smape(actual, predicted),
        "directional_accuracy": directional_accuracy(actual, predicted, last_observed),
    }


def aggregate(per_origin: list) -> Dict[str, float]:
    """Mean of each metric across origins, ignoring NaNs (an origin whose
    actuals were all flat contributes no directional score but its error
    metrics still count)."""
    if not per_origin:
        return {}
    keys = per_origin[0].keys()
    out = {}
    for k in keys:
        vals = np.array([m[k] for m in per_origin], dtype=float)
        vals = vals[~np.isnan(vals)]
        out[k] = float(np.mean(vals)) if vals.size else float("nan")
    return out
