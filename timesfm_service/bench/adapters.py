"""Model adapters — one interface, several forecasters.

Every adapter answers the same question: given a context window of OHLCV
history, what are the next `horizon` CLOSING prices? Returning a plain array
of closes is what makes TimesFM (univariate) and Kronos (multivariate)
comparable at all.

Heavy imports are deferred into `load()` so the harness, its tests, and the
baselines all run with nothing but numpy/pandas installed. Only the adapter
you actually select pays for its dependencies.
"""
from typing import List, Optional

import numpy as np
import pandas as pd

CLOSE = "close"
OHLCV = ["open", "high", "low", "close", "volume"]


class Forecaster:
    """Interface. `requires` lists the columns the adapter reads, so the
    runner can fail fast on a CSV that can't feed the chosen model."""

    name: str = "base"
    requires: List[str] = [CLOSE]

    def load(self) -> None:
        """Optional one-time setup (model download, compile). Called once."""

    def predict(self, context: pd.DataFrame, horizon: int) -> np.ndarray:
        raise NotImplementedError


# ── Baselines ────────────────────────────────────────────────────────────────
# These exist to answer the only question that matters first: does either
# foundation model beat "nothing happens"? On financial series that is a
# genuinely hard bar — random-walk-like prices mean the last value is a strong
# predictor, and a model that can't clear it has no business sizing a trade.

class NaiveForecaster(Forecaster):
    """Last observed close, held flat across the horizon (random-walk
    assumption). The bar every other model has to clear."""

    name = "naive-last"
    requires = [CLOSE]

    def predict(self, context: pd.DataFrame, horizon: int) -> np.ndarray:
        return np.full(horizon, float(context[CLOSE].iloc[-1]), dtype=float)


class DriftForecaster(Forecaster):
    """Linear drift: extends the average per-step change of the context
    window. Catches the case where a model is only reproducing recent trend."""

    name = "naive-drift"
    requires = [CLOSE]

    def __init__(self, lookback: int = 20):
        self.lookback = lookback

    def predict(self, context: pd.DataFrame, horizon: int) -> np.ndarray:
        closes = context[CLOSE].to_numpy(dtype=float)
        window = closes[-min(self.lookback, len(closes)):]
        step = (window[-1] - window[0]) / max(1, len(window) - 1)
        last = closes[-1]
        return last + step * np.arange(1, horizon + 1, dtype=float)


# ── TimesFM ──────────────────────────────────────────────────────────────────

class TimesFMForecaster(Forecaster):
    """Google TimesFM 2.5 — general-purpose, univariate. Mirrors the model
    and compile settings the live service in ../main.py uses, so the
    comparison reflects what FinSurfing actually runs today rather than a
    differently-tuned instance."""

    name = "timesfm-2.5-200m"
    requires = [CLOSE]

    def __init__(self, max_context: int = 512, max_horizon: int = 90):
        self.max_context = max_context
        self.max_horizon = max_horizon
        self._model = None

    def load(self) -> None:
        import timesfm

        model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(
            "google/timesfm-2.5-200m-pytorch"
        )
        model.compile(
            timesfm.ForecastConfig(
                max_context=self.max_context,
                max_horizon=self.max_horizon,
                normalize_inputs=True,
                use_continuous_quantile_head=True,
            )
        )
        self._model = model

    def predict(self, context: pd.DataFrame, horizon: int) -> np.ndarray:
        if self._model is None:
            self.load()
        closes = context[CLOSE].to_numpy(dtype=np.float32)[-self.max_context:]
        point_fc, _ = self._model.forecast(horizon=horizon, inputs=[closes])
        return np.asarray(point_fc[0], dtype=float)[:horizon]


# ── Kronos ───────────────────────────────────────────────────────────────────

class KronosForecaster(Forecaster):
    """Kronos — financial K-line foundation model, multivariate OHLCV.

    UNVERIFIED against the real package: this adapter was written from the
    project's documented `KronosPredictor` usage, not by running it. Before
    trusting any number it produces, run `--self-check` (see run.py), which
    forces a single forecast and prints the raw output shape. If the API has
    moved, this class is the only place that needs changing.

    Kronos is autoregressive and samples, so it is not deterministic. Fix
    `seed` for a reproducible comparison, and prefer `sample_count > 1` (it
    averages samples) when you care about the point estimate more than speed.
    """

    name = "kronos-small"
    requires = OHLCV

    def __init__(
        self,
        model_id: str = "NeoQuasar/Kronos-small",
        tokenizer_id: str = "NeoQuasar/Kronos-Tokenizer-base",
        device: str = "cpu",
        max_context: int = 512,
        temperature: float = 1.0,
        top_p: float = 0.9,
        sample_count: int = 1,
        seed: Optional[int] = 42,
    ):
        self.model_id = model_id
        self.tokenizer_id = tokenizer_id
        self.device = device
        self.max_context = max_context
        self.temperature = temperature
        self.top_p = top_p
        self.sample_count = sample_count
        self.seed = seed
        self._predictor = None
        self.name = f"kronos:{model_id.split('/')[-1]}"

    def load(self) -> None:
        # The Kronos repo is used as a source checkout (its `model` package is
        # not published to PyPI), so it must be importable — clone it and set
        # KRONOS_PATH, or install it into the environment.
        from model import Kronos, KronosPredictor, KronosTokenizer

        tokenizer = KronosTokenizer.from_pretrained(self.tokenizer_id)
        model = Kronos.from_pretrained(self.model_id)
        self._predictor = KronosPredictor(
            model, tokenizer, device=self.device, max_context=self.max_context
        )

    def predict(self, context: pd.DataFrame, horizon: int) -> np.ndarray:
        if self._predictor is None:
            self.load()
        if self.seed is not None:
            import torch

            torch.manual_seed(self.seed)

        window = context.iloc[-self.max_context:]
        x_df = window[OHLCV].reset_index(drop=True)
        x_timestamp = pd.Series(window["timestamp"].to_numpy())
        # Future timestamps: continue the context's own cadence so the model
        # sees a plausible calendar rather than a guessed one.
        step = x_timestamp.iloc[-1] - x_timestamp.iloc[-2]
        y_timestamp = pd.Series(
            [x_timestamp.iloc[-1] + step * (i + 1) for i in range(horizon)]
        )

        pred_df = self._predictor.predict(
            df=x_df,
            x_timestamp=x_timestamp,
            y_timestamp=y_timestamp,
            pred_len=horizon,
            T=self.temperature,
            top_p=self.top_p,
            sample_count=self.sample_count,
        )
        return np.asarray(pred_df[CLOSE], dtype=float)[:horizon]


# ── Registry ─────────────────────────────────────────────────────────────────

def build(spec: str, device: str = "cpu") -> Forecaster:
    """Construct an adapter from a CLI name."""
    spec = spec.strip()
    # Only the prefix is matched case-insensitively: everything after ':' is a
    # HuggingFace model id, and those are case-SENSITIVE — lowercasing the
    # whole spec turns "NeoQuasar/Kronos-base" into a 404.
    prefix = spec.split(":", 1)[0].lower()

    if prefix in ("naive", "naive-last"):
        return NaiveForecaster()
    if prefix in ("drift", "naive-drift"):
        return DriftForecaster()
    if prefix.startswith("timesfm"):
        return TimesFMForecaster()
    if prefix.startswith("kronos"):
        # "kronos" → default small; "kronos:NeoQuasar/Kronos-base" → explicit.
        if ":" in spec:
            return KronosForecaster(model_id=spec.split(":", 1)[1], device=device)
        return KronosForecaster(device=device)
    raise ValueError(
        f"unknown model '{spec}' (expected: naive, drift, timesfm, kronos[:model_id])"
    )
