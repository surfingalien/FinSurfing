#!/bin/bash
set -e

mkdir -p ~/.openbb_platform

cat > ~/.openbb_platform/user_settings.json <<EOF
{
  "credentials": {
    "fmp_api_key": "${FMP_API_KEY:-}",
    "fred_api_key": "${FRED_API_KEY:-}",
    "polygon_api_key": "${POLYGON_API_KEY:-}",
    "intrinio_api_key": "${INTRINIO_API_KEY:-}",
    "benzinga_api_key": "${BENZINGA_API_KEY:-}",
    "alpha_vantage_api_key": "${ALPHA_VANTAGE_API_KEY:-}",
    "tiingo_token": "${TIINGO_API_KEY:-}"
  },
  "preferences": {
    "output_type": "OBBject"
  }
}
EOF

HOST="${OPENBB_HOST:-0.0.0.0}"
PORT="${OPENBB_PORT:-6900}"

# openbb-platform-api 1.x entry point
exec python -m uvicorn openbb_platform_api.main:app \
  --host "$HOST" \
  --port "$PORT" \
  --workers 1
