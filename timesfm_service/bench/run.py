"""Walk-forward comparison: Kronos vs TimesFM vs naive baselines.

Answers one question with numbers instead of vibes: on OUR data, does either
foundation model forecast better than assuming nothing happens?

    # plumbing check — no model weights needed
    python -m bench.run --synthetic --models naive,drift

    # the real comparison
    python -m bench.run --csv data/BTC-USD-1d.csv \
        --models naive,drift,timesfm,kronos --context 512 --horizon 30

    # confirm the Kronos adapter matches the installed package before trusting it
    python -m bench.run --csv data/BTC-USD-1d.csv --models kronos --self-check

Run from the `timesfm_service` directory. If Kronos lives in a source
checkout, point at it first:  export PYTHONPATH=/path/to/Kronos:$PYTHONPATH
"""
import argparse
import json
import sys
import time
from typing import Dict, List

import numpy as np

from bench import adapters, data, metrics

# Horizon steps worth reporting separately: tomorrow, next week, next month.
# A model can be good at one and useless at another, and an average over the
# whole horizon hides exactly that.
CHECKPOINT_STEPS = [1, 7, 30]


def run_model(
    forecaster: adapters.Forecaster, df, origins: List[int],
    context_len: int, horizon: int, verbose: bool = True,
) -> Dict:
    """Score one forecaster across every origin."""
    per_origin = []
    per_step_err = {s: [] for s in CHECKPOINT_STEPS if s <= horizon}
    per_step_dir = {s: [] for s in CHECKPOINT_STEPS if s <= horizon}
    failures = 0
    started = time.time()

    for n, origin in enumerate(origins, 1):
        context = df.iloc[origin - context_len:origin]
        actual = df["close"].to_numpy(dtype=float)[origin:origin + horizon]
        last_observed = float(context["close"].iloc[-1])

        try:
            predicted = np.asarray(forecaster.predict(context, horizon), dtype=float)
        except Exception as exc:  # one bad origin shouldn't void the whole run
            failures += 1
            if failures <= 3:
                print(f"  ! {forecaster.name} failed at origin {origin}: {exc}", file=sys.stderr)
            continue

        if predicted.shape[0] != horizon:
            failures += 1
            if failures <= 3:
                print(
                    f"  ! {forecaster.name} returned {predicted.shape[0]} values, "
                    f"expected {horizon} (origin {origin})", file=sys.stderr
                )
            continue

        per_origin.append(metrics.evaluate(actual, predicted, last_observed))

        for step in per_step_err:
            i = step - 1
            per_step_err[step].append(abs(actual[i] - predicted[i]) / actual[i] * 100
                                      if actual[i] else np.nan)
            a_dir = np.sign(actual[i] - last_observed)
            p_dir = np.sign(predicted[i] - last_observed)
            # Same abstention rule as metrics.directional_accuracy: a flat
            # prediction made no call, so it is not scored either way.
            if a_dir != 0 and p_dir != 0:
                per_step_dir[step].append(float(a_dir == p_dir) * 100)

        if verbose and n % 25 == 0:
            print(f"  {forecaster.name}: {n}/{len(origins)} origins", file=sys.stderr)

    elapsed = time.time() - started
    result = {
        "model": forecaster.name,
        "origins_scored": len(per_origin),
        "origins_failed": failures,
        "seconds": round(elapsed, 2),
        "seconds_per_forecast": round(elapsed / max(1, len(per_origin)), 3),
        "overall": metrics.aggregate(per_origin),
        "by_step": {
            f"{s}d": {
                "mape": float(np.nanmean(per_step_err[s])) if per_step_err[s] else float("nan"),
                "directional_accuracy": float(np.mean(per_step_dir[s])) if per_step_dir[s] else float("nan"),
            }
            for s in per_step_err
        },
    }
    return result


def _fmt(value: float, suffix: str = "") -> str:
    return "   n/a" if value is None or np.isnan(value) else f"{value:7.3f}{suffix}"


def report(results: List[Dict], horizon: int) -> None:
    """Print the comparison, with the naive baseline as the reference line."""
    baseline = next((r for r in results if r["model"] == "naive-last"), None)

    print("\n" + "=" * 78)
    print(f"WALK-FORWARD FORECAST COMPARISON — horizon {horizon} steps")
    print("=" * 78)
    print(f"{'model':<22}{'MAPE%':>10}{'sMAPE%':>10}{'RMSE':>12}{'dir.acc%':>11}{'sec/fc':>9}")
    print("-" * 78)
    for r in results:
        o = r["overall"]
        print(
            f"{r['model']:<22}"
            f"{_fmt(o.get('mape', float('nan')))}"
            f"{_fmt(o.get('smape', float('nan')))}"
            f"{o.get('rmse', float('nan')):12.2f}"
            f"{_fmt(o.get('directional_accuracy', float('nan')))}"
            f"{r['seconds_per_forecast']:9.3f}"
        )
        if r["origins_failed"]:
            print(f"{'':<22}({r['origins_failed']} origin(s) failed)")

    print("\nPer-horizon MAPE% / directional accuracy%:")
    steps = sorted({s for r in results for s in r["by_step"]},
                   key=lambda x: int(x.rstrip("d")))
    print(f"{'model':<22}" + "".join(f"{s:>18}" for s in steps))
    print("-" * 78)
    for r in results:
        cells = ""
        for s in steps:
            b = r["by_step"].get(s)
            if not b:
                cells += f"{'—':>18}"
            elif np.isnan(b["directional_accuracy"]):
                cells += f"{b['mape']:9.2f} /   n/a"      # forecaster abstained
            else:
                cells += f"{b['mape']:9.2f} /{b['directional_accuracy']:6.1f}"
        print(f"{r['model']:<22}{cells}")

    # The verdict that actually decides adoption.
    if baseline:
        print("\n" + "-" * 78)
        print("VERDICT vs naive-last (the bar a forecaster must clear):")
        b_mape = baseline["overall"].get("mape", float("nan"))
        for r in results:
            if r["model"] == "naive-last":
                continue
            mape_delta = b_mape - r["overall"].get("mape", float("nan"))
            better = mape_delta > 0
            # Direction is scored against a coin flip, NOT against naive-last:
            # a flat forecast abstains from calling direction, so comparing to
            # it would flatter every other model by ~50 points.
            dir_acc = r["overall"].get("directional_accuracy", float("nan"))
            dir_edge = "   n/a" if np.isnan(dir_acc) else f"{dir_acc - 50.0:+.1f} pts vs coin flip"
            print(
                f"  {r['model']:<22} MAPE {'better' if better else 'WORSE '} by "
                f"{abs(mape_delta):.3f} pts   |   directional {dir_edge}"
            )
        print(
            "\n  A model that does not beat naive-last on MAPE *and* hold >50% "
            "directional\n  accuracy has not earned a place in the forecast path. "
            "Accuracy alone is\n  still not proof of profitability — costs and slippage "
            "come after this."
        )
    print("=" * 78 + "\n")


def self_check(forecaster: adapters.Forecaster, df, context_len: int, horizon: int) -> int:
    """One forecast, printed raw — proves an adapter matches its installed
    package before any comparison numbers are believed."""
    print(f"Self-check: {forecaster.name}")
    context = df.iloc[:context_len]
    try:
        forecaster.load()
        print("  load(): ok")
        out = np.asarray(forecaster.predict(context, horizon), dtype=float)
    except Exception as exc:
        print(f"  FAILED: {type(exc).__name__}: {exc}")
        print("\n  If this is an import error, the package isn't installed/on PYTHONPATH.")
        print("  If it's a TypeError/AttributeError, the adapter's API assumptions in")
        print("  bench/adapters.py need updating against the installed version.")
        return 1
    print(f"  predict(): returned shape {out.shape}, expected ({horizon},)")
    print(f"  first 5 values: {np.round(out[:5], 4).tolist()}")
    ok = out.shape == (horizon,) and np.isfinite(out).all()
    print(f"  {'OK' if ok else 'SUSPECT — wrong shape or non-finite values'}")
    return 0 if ok else 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--csv", help="OHLCV CSV (timestamp,open,high,low,close,volume)")
    src.add_argument("--synthetic", action="store_true",
                     help="random-walk data — plumbing check only, numbers are meaningless")
    ap.add_argument("--models", default="naive,drift",
                    help="comma-separated: naive,drift,timesfm,kronos[:model_id]")
    ap.add_argument("--context", type=int, default=512, help="context window length")
    ap.add_argument("--horizon", type=int, default=30, help="steps to forecast and score")
    ap.add_argument("--stride", type=int, default=5, help="rows between origins")
    ap.add_argument("--max-origins", type=int, default=50,
                    help="cap origins (most recent kept); 0 = no cap")
    ap.add_argument("--device", default="cpu", help="torch device for Kronos")
    ap.add_argument("--json", help="write full results to this path")
    ap.add_argument("--self-check", action="store_true",
                    help="run one forecast per model and print raw output, then exit")
    args = ap.parse_args(argv)

    df = data.synthetic_ohlcv() if args.synthetic else data.load_csv(args.csv)
    print(f"Loaded {len(df)} rows "
          f"({df['timestamp'].iloc[0].date()} → {df['timestamp'].iloc[-1].date()})")

    specs = [s for s in (m.strip() for m in args.models.split(",")) if s]
    forecasters = [adapters.build(s, device=args.device) for s in specs]

    if args.self_check:
        return max(self_check(f, df, args.context, args.horizon) for f in forecasters)

    origins = data.walk_forward_origins(
        len(df), args.context, args.horizon, args.stride, args.max_origins
    )
    if not origins:
        print(
            f"Not enough data: need more than context({args.context}) + "
            f"horizon({args.horizon}) = {args.context + args.horizon} rows, have {len(df)}.",
            file=sys.stderr,
        )
        return 2
    print(f"Scoring {len(origins)} origins × {args.horizon}-step horizon "
          f"(context {args.context}, stride {args.stride})\n")

    results = []
    for f in forecasters:
        print(f"Running {f.name}...", file=sys.stderr)
        results.append(run_model(f, df, origins, args.context, args.horizon))

    report(results, args.horizon)

    if args.json:
        payload = {
            "config": {
                "source": "synthetic" if args.synthetic else args.csv,
                "rows": len(df),
                "context": args.context,
                "horizon": args.horizon,
                "stride": args.stride,
                "origins": len(origins),
            },
            "results": results,
        }
        with open(args.json, "w") as fh:
            json.dump(payload, fh, indent=2)
        print(f"Wrote {args.json}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
