"""Tests for the parts of the harness that can be wrong silently.

Model adapters aren't tested here — they need real weights, and a mocked
adapter would only prove the mock works. What IS tested is everything the
comparison's honesty rests on: the metric math, and the walk-forward slicing
that must never let a forecast see its own answer.
"""
import numpy as np
import pandas as pd
import pytest

from bench import adapters, data, metrics


# ── metrics ──────────────────────────────────────────────────────────────────

def test_perfect_forecast_scores_zero_error():
    actual = [100.0, 101.0, 102.0]
    m = metrics.evaluate(actual, actual, last_observed=99.0)
    assert m["mae"] == 0.0
    assert m["rmse"] == 0.0
    assert m["mape"] == 0.0
    assert m["directional_accuracy"] == 100.0


def test_known_error_values():
    actual = [100.0, 100.0]
    predicted = [110.0, 90.0]          # +10 and -10
    assert metrics.mae(actual, predicted) == pytest.approx(10.0)
    assert metrics.rmse(actual, predicted) == pytest.approx(10.0)
    assert metrics.mape(actual, predicted) == pytest.approx(10.0)


def test_rmse_punishes_concentrated_errors_more_than_mae():
    actual = [100.0, 100.0]
    concentrated = [100.0, 140.0]      # errors 0 and 40
    even = [80.0, 120.0]               # errors 20 and 20 — same MAE
    assert metrics.mae(actual, concentrated) == metrics.mae(actual, even) == 20.0
    assert metrics.rmse(actual, concentrated) > metrics.rmse(actual, even)


def test_directional_accuracy_measures_from_last_observed():
    last = 100.0
    actual = [105.0, 110.0, 95.0, 90.0]        # up, up, down, down
    predicted = [101.0, 102.0, 99.0, 150.0]    # up, up, down, UP (wrong)
    assert metrics.directional_accuracy(actual, predicted, last) == pytest.approx(75.0)


def test_flat_actual_steps_are_not_scored_for_direction():
    last = 100.0
    # Every actual equals the last observed price: no direction exists.
    assert np.isnan(metrics.directional_accuracy([100.0, 100.0], [105.0, 95.0], last))


def test_mape_ignores_zero_actuals_instead_of_exploding():
    assert np.isfinite(metrics.mape([0.0, 100.0], [5.0, 110.0]))


def test_smape_is_bounded_where_mape_is_not():
    # A near-zero actual sends MAPE to a huge number; sMAPE stays <= 200.
    assert metrics.mape([0.01, 100.0], [50.0, 100.0]) > 1000
    assert metrics.smape([0.01, 100.0], [50.0, 100.0]) <= 200.0


def test_length_mismatch_is_an_error_not_a_silent_truncation():
    with pytest.raises(ValueError):
        metrics.mae([1.0, 2.0, 3.0], [1.0, 2.0])


def test_aggregate_ignores_nan_metrics():
    agg = metrics.aggregate([
        {"mape": 1.0, "directional_accuracy": float("nan")},
        {"mape": 3.0, "directional_accuracy": 60.0},
    ])
    assert agg["mape"] == pytest.approx(2.0)
    assert agg["directional_accuracy"] == pytest.approx(60.0)


# ── walk-forward slicing: the no-lookahead guarantee ─────────────────────────

def test_origins_leave_room_for_full_context_and_horizon():
    origins = data.walk_forward_origins(n_rows=100, context_len=20, horizon=10, stride=1)
    assert origins[0] == 20                    # never starts before a full context
    assert origins[-1] == 90                   # never scores a partial horizon
    assert max(origins) + 10 <= 100


def test_context_and_actuals_never_overlap():
    """The property that makes the whole comparison honest."""
    df = data.synthetic_ohlcv(n=200, seed=1)
    context_len, horizon = 50, 10
    for origin in data.walk_forward_origins(len(df), context_len, horizon, stride=7):
        context = df.iloc[origin - context_len:origin]
        actual = df.iloc[origin:origin + horizon]
        assert len(context) == context_len
        assert len(actual) == horizon
        assert context["timestamp"].max() < actual["timestamp"].min()


def test_no_origins_when_data_is_too_short():
    assert data.walk_forward_origins(n_rows=30, context_len=25, horizon=10) == []


def test_max_origins_keeps_the_most_recent():
    origins = data.walk_forward_origins(200, 20, 10, stride=1, max_origins=5)
    assert len(origins) == 5
    assert origins[-1] == 190                  # newest window retained


def test_stride_controls_spacing():
    origins = data.walk_forward_origins(200, 20, 10, stride=10, max_origins=0)
    assert origins[1] - origins[0] == 10


def test_invalid_parameters_rejected():
    with pytest.raises(ValueError):
        data.walk_forward_origins(100, context_len=0, horizon=10)


# ── loader ───────────────────────────────────────────────────────────────────

def test_load_csv_normalizes_aliases_and_sorts(tmp_path):
    csv = tmp_path / "prices.csv"
    csv.write_text(
        "Date,Open,High,Low,Adj Close,Volume\n"
        "2024-01-03,3,4,2,3.5,100\n"
        "2024-01-01,1,2,0.5,1.5,300\n"     # out of order on purpose
        "2024-01-02,2,3,1.5,2.5,200\n"
    )
    df = data.load_csv(str(csv))
    assert list(df.columns) == ["timestamp", "open", "high", "low", "close", "volume"]
    assert df["close"].tolist() == [1.5, 2.5, 3.5]          # sorted oldest → newest
    assert df["timestamp"].is_monotonic_increasing


def test_missing_columns_name_what_is_missing(tmp_path):
    csv = tmp_path / "bad.csv"
    csv.write_text("date,close\n2024-01-01,100\n")
    with pytest.raises(ValueError, match="missing required column"):
        data.load_csv(str(csv))


# ── baselines ────────────────────────────────────────────────────────────────

def test_naive_holds_the_last_close_flat():
    df = data.synthetic_ohlcv(n=60, seed=3)
    out = adapters.NaiveForecaster().predict(df, horizon=5)
    assert out.shape == (5,)
    assert np.allclose(out, df["close"].iloc[-1])


def test_drift_extends_a_clean_trend():
    df = pd.DataFrame({
        "timestamp": pd.date_range("2024-01-01", periods=20, freq="D", tz="UTC"),
        "close": np.arange(100.0, 120.0),      # +1 per step
    })
    out = adapters.DriftForecaster(lookback=20).predict(df, horizon=3)
    assert out == pytest.approx([120.0, 121.0, 122.0])


def test_build_registry_and_unknown_model():
    assert adapters.build("naive").name == "naive-last"
    assert adapters.build("drift").name == "naive-drift"
    assert adapters.build("kronos:NeoQuasar/Kronos-base").name == "kronos:Kronos-base"
    with pytest.raises(ValueError, match="unknown model"):
        adapters.build("gpt-crystal-ball")


def test_flat_forecast_abstains_rather_than_scoring_zero():
    """A flat (naive) forecast makes no directional claim. Scoring it 0%
    would misrepresent it as wrong and inflate every rival by comparison."""
    last = 100.0
    flat = [100.0, 100.0, 100.0]
    actual = [105.0, 95.0, 110.0]
    assert np.isnan(metrics.directional_accuracy(actual, flat, last))


def test_partially_flat_forecast_scores_only_its_real_calls():
    last = 100.0
    predicted = [100.0, 105.0, 95.0]   # abstain, up, down
    actual = [105.0, 110.0, 110.0]     # up,    up, up  -> 1 of 2 real calls right
    assert metrics.directional_accuracy(actual, predicted, last) == pytest.approx(50.0)
