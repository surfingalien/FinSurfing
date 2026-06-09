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

echo "[start.sh] settings written, discovering installed modules..."
python -c "import openbb_platform_api; print('[start.sh] openbb_platform_api found at', openbb_platform_api.__file__)"

HOST="${OPENBB_HOST:-0.0.0.0}"
PORT="${OPENBB_PORT:-6900}"

echo "[start.sh] starting uvicorn on $HOST:$PORT"
exec python -m uvicorn openbb_platform_api.main:app \
  --host "$HOST" \
  --port "$PORT" \
  --workers 1
