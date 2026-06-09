#!/bin/bash
set -e

mkdir -p ~/.openbb_platform

cat > ~/.openbb_platform/user_settings.json <<EOF
{
  "credentials": {
    "fmp_api_key": "${FMP_API_KEY:-}",
    "fred_api_key": "${FRED_API_KEY:-}",
    "polygon_api_key": "${POLYGON_API_KEY:-}"
  },
  "preferences": {
    "output_type": "OBBject"
  }
}
EOF

HOST="${OPENBB_HOST:-0.0.0.0}"
PORT="${PORT:-${OPENBB_PORT:-6900}}"

echo "[start.sh] HOST=$HOST PORT=$PORT"

# Discover the correct app entry point at runtime
APP_MODULE=""
python - <<'PYEOF'
import sys
attempts = [
    ("openbb_platform_api.main", "app"),
    ("openbb_platform_api.app", "app"),
    ("openbb_core.api.rest_api", "app"),
    ("openbb_platform_api", "app"),
]
for mod, attr in attempts:
    try:
        m = __import__(mod, fromlist=[attr])
        getattr(m, attr)
        print(f"{mod}:{attr}")
        sys.exit(0)
    except Exception as e:
        print(f"[skip] {mod}:{attr} — {e}", file=sys.stderr)
print("ERROR: no valid app module found", file=sys.stderr)
sys.exit(1)
PYEOF

APP_MODULE=$(python - <<'PYEOF'
import sys
attempts = [
    ("openbb_platform_api.main", "app"),
    ("openbb_platform_api.app", "app"),
    ("openbb_core.api.rest_api", "app"),
    ("openbb_platform_api", "app"),
]
for mod, attr in attempts:
    try:
        m = __import__(mod, fromlist=[attr])
        getattr(m, attr)
        print(f"{mod}:{attr}")
        sys.exit(0)
    except Exception:
        pass
sys.exit(1)
PYEOF
)

echo "[start.sh] using app module: $APP_MODULE"
exec python -m uvicorn "$APP_MODULE" \
  --host "$HOST" \
  --port "$PORT" \
  --workers 1
