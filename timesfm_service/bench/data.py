"""OHLCV loading and walk-forward slicing.

The slicing here is the part of the harness that decides whether the whole
comparison is honest, so it is deliberately small and directly tested: a
forecast origin sees rows strictly BEFORE it and is scored against rows
strictly AFTER it. No row is ever in both.
"""
from typing import List

import numpy as np
import pandas as pd

REQUIRED = ["open", "high", "low", "close", "volume"]

_ALIASES = {
    "date": "timestamp", "time": "timestamp", "datetime": "timestamp",
    "o": "open", "h": "high", "l": "low", "c": "close", "v": "volume",
    "adj close": "close", "adj_close": "close", "vol": "volume",
}


def load_csv(path: str) -> pd.DataFrame:
    """Load OHLCV from CSV, normalize column names, sort oldest → newest.

    Accepts the usual column spellings (Date/Close/Adj Close/…). Raises with a
    specific message naming what's missing rather than failing later inside a
    model call.
    """
    df = pd.read_csv(path)
    df.columns = [_ALIASES.get(c.strip().lower(), c.strip().lower()) for c in df.columns]

    missing = [c for c in REQUIRED if c not in df.columns]
    if missing:
        raise ValueError(
            f"{path}: missing required column(s) {missing}. "
            f"Found: {sorted(df.columns)}"
        )

    if "timestamp" not in df.columns:
        raise ValueError(
            f"{path}: no timestamp/date column found. Kronos needs real "
            f"timestamps; add a 'timestamp' or 'date' column."
        )

    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    if df["timestamp"].isna().any():
        bad = int(df["timestamp"].isna().sum())
        raise ValueError(f"{path}: {bad} row(s) have an unparseable timestamp")

    df = df.sort_values("timestamp").reset_index(drop=True)

    for col in REQUIRED:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    if df[REQUIRED].isna().any().any():
        raise ValueError(f"{path}: non-numeric or missing values in OHLCV columns")

    return df[["timestamp", *REQUIRED]]


def walk_forward_origins(
    n_rows: int, context_len: int, horizon: int, stride: int = 1,
    max_origins: int = 0,
) -> List[int]:
    """Origin indices for a walk-forward evaluation.

    An origin `i` means: context is rows [i-context_len, i), the forecast is
    scored against rows [i, i+horizon). Origins therefore start at
    `context_len` and stop early enough that a full horizon of actuals exists
    — a partially-scored origin would quietly weight short horizons higher.

    When `max_origins` is set, the most RECENT origins are kept: recent market
    behaviour is the relevant test, and it keeps runs bounded on slow models.
    """
    if context_len < 1 or horizon < 1 or stride < 1:
        raise ValueError("context_len, horizon and stride must all be >= 1")

    last_origin = n_rows - horizon
    if last_origin <= context_len:
        return []

    origins = list(range(context_len, last_origin + 1, stride))
    if max_origins and len(origins) > max_origins:
        origins = origins[-max_origins:]
    return origins


def synthetic_ohlcv(n: int = 900, seed: int = 7, start: float = 100.0) -> pd.DataFrame:
    """Geometric-random-walk OHLCV for smoke tests and demos.

    Explicitly NOT a market simulator — it exists so the harness can be
    exercised end-to-end without a data feed. Any accuracy number produced on
    this data is meaningless; it only proves the plumbing runs.
    """
    rng = np.random.default_rng(seed)
    returns = rng.normal(0.0004, 0.02, n)
    close = start * np.exp(np.cumsum(returns))
    spread = np.abs(rng.normal(0.004, 0.002, n)) * close
    open_ = np.concatenate([[start], close[:-1]])
    return pd.DataFrame({
        "timestamp": pd.date_range("2022-01-01", periods=n, freq="D", tz="UTC"),
        "open": open_,
        "high": np.maximum(open_, close) + spread,
        "low": np.minimum(open_, close) - spread,
        "close": close,
        "volume": rng.uniform(1e5, 5e5, n),
    })
