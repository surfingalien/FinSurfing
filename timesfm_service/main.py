"""
TimesFM microservice — Google TimesFM 2.5 (200M params) for price forecasting.
Runs as a FastAPI server on port 8000 alongside the Node.js app.

Deploy on Railway as a second process in Procfile:
  forecast: cd timesfm_service && uvicorn main:app --host 0.0.0.0 --port ${TIMESFM_PORT:-8000}
"""

import os
import logging
from contextlib import asynccontextmanager
from typing import Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ── Model singleton ───────────────────────────────────────────────────────────

_model = None

def get_model():
    global _model
    if _model is not None:
        return _model

    log.info("Loading TimesFM 2.5-200M from HuggingFace...")
    import timesfm
    _model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(
        "google/timesfm-2.5-200m-pytorch",
        local_files_only=False,
    )
    _model.compile(
        timesfm.ForecastConfig(
            max_context=512,
            max_horizon=90,
            normalize_inputs=True,
            use_continuous_quantile_head=True,
        )
    )
    log.info("TimesFM model ready.")
    return _model


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Eager load on startup so first request isn't slow
    if os.getenv("TIMESFM_EAGER_LOAD", "1") == "1":
        try:
            get_model()
        except Exception as e:
            log.warning(f"Eager model load failed (will retry on first request): {e}")
    yield


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="FinSurfing TimesFM Service", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3001", "http://localhost:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# ── Schemas ──────────────────────────────────────────────────────────────────

class ForecastRequest(BaseModel):
    symbol: str
    closes: list[float]          # ordered oldest → newest, up to 512 values

    @field_validator("closes")
    @classmethod
    def validate_closes(cls, v):
        if len(v) < 20:
            raise ValueError("At least 20 closing prices required")
        return v

    @field_validator("symbol")
    @classmethod
    def validate_symbol(cls, v):
        v = v.strip().upper()
        if not v or len(v) > 20:
            raise ValueError("Invalid symbol")
        return v


class HorizonForecast(BaseModel):
    point: float
    p10:   float
    p50:   float
    p90:   float
    upside: Optional[float]      # % from current price
    range:  Optional[float]      # p10→p90 width as % of price


class ForecastResponse(BaseModel):
    symbol:        str
    current_price: float
    model:         str
    horizon_days:  int
    forecasts:     dict[str, HorizonForecast]
    series:        list[float]   # 90 daily point forecasts for chart overlay


# ── Routes ───────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"ok": True, "model": "timesfm-2.5-200m", "loaded": _model is not None}


@app.post("/predict", response_model=ForecastResponse)
def predict(req: ForecastRequest):
    try:
        model = get_model()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Model unavailable: {e}")

    closes = req.closes[-512:]          # cap at context window
    current_price = closes[-1]

    try:
        inputs = [np.array(closes, dtype=np.float32)]
        point_fc, quantile_fc = model.forecast(horizon=90, inputs=inputs)

        # point_fc:    (1, 90)
        # quantile_fc: (1, 90, 11) — quantiles at 0.0, 0.1, ..., 1.0
        p  = point_fc[0].tolist()
        q  = quantile_fc[0].tolist()   # 90 × 11

    except Exception as e:
        log.error(f"TimesFM inference error for {req.symbol}: {e}")
        raise HTTPException(status_code=500, detail=f"Inference failed: {e}")

    def horizon_entry(idx: int) -> HorizonForecast:
        pt   = float(p[idx])
        p10  = float(q[idx][1])   # quantile index 1 = 0.10
        p50  = float(q[idx][5])   # quantile index 5 = 0.50
        p90  = float(q[idx][9])   # quantile index 9 = 0.90
        upside = round((pt - current_price) / current_price * 100, 2) if current_price > 0 else None
        rng    = round((p90 - p10) / current_price * 100, 2)          if current_price > 0 else None
        return HorizonForecast(point=round(pt, 4), p10=round(p10, 4), p50=round(p50, 4),
                               p90=round(p90, 4), upside=upside, range=rng)

    forecasts = {
        "7d":  horizon_entry(6),
        "30d": horizon_entry(29),
        "90d": horizon_entry(89),
    }

    log.info(
        f"[{req.symbol}] price={current_price:.2f}  "
        f"7d={forecasts['7d'].point:.2f}({forecasts['7d'].upside:+.1f}%)  "
        f"30d={forecasts['30d'].point:.2f}({forecasts['30d'].upside:+.1f}%)  "
        f"90d={forecasts['90d'].point:.2f}({forecasts['90d'].upside:+.1f}%)"
    )

    return ForecastResponse(
        symbol=req.symbol,
        current_price=current_price,
        model="google/timesfm-2.5-200m-pytorch",
        horizon_days=90,
        forecasts=forecasts,
        series=[round(v, 4) for v in p],
    )
