#!/bin/sh
# Generates ~/.openbb_platform/user_settings.json from Railway env vars,
# then starts the OpenBB FastAPI server.

set -e

SETTINGS_DIR="$HOME/.openbb_platform"
SETTINGS_FILE="$SETTINGS_DIR/user_settings.json"
mkdir -p "$SETTINGS_DIR"

# Build credentials block from env vars — only include keys that are set
CREDS="{"
FIRST=1

add_key() {
  NAME=$1
  VALUE=$2
  if [ -n "$VALUE" ]; then
    if [ $FIRST -eq 0 ]; then CREDS="$CREDS,"; fi
    CREDS="$CREDS\"$NAME\":\"$VALUE\""
    FIRST=0
  fi
}

add_key "fmp_api_key"         "$FMP_API_KEY"
add_key "fred_api_key"        "$FRED_API_KEY"
add_key "polygon_api_key"     "$POLYGON_API_KEY"
add_key "intrinio_api_key"    "$INTRINIO_API_KEY"
add_key "benzinga_api_key"    "$BENZINGA_API_KEY"
add_key "alpha_vantage_api_key" "$ALPHA_VANTAGE_API_KEY"
add_key "tiingo_token"        "$TIINGO_API_KEY"

CREDS="$CREDS}"

cat > "$SETTINGS_FILE" <<EOF
{
  "credentials": $CREDS,
  "preferences": {
    "output_type": "dataframe",
    "table_style": "ocean",
    "plot_enable_pct_change": false
  }
}
EOF

echo "[OpenBB] Settings written to $SETTINGS_FILE"
echo "[OpenBB] Configured providers: $(echo $CREDS | grep -o '"[a-z_]*_api_key"' | wc -l) keys"

# Start FastAPI server
HOST="${OPENBB_HOST:-0.0.0.0}"
PORT="${OPENBB_PORT:-6900}"

echo "[OpenBB] Starting API server on $HOST:$PORT"
exec python -m uvicorn openbb_core.api.rest_api:app \
  --host "$HOST" \
  --port "$PORT" \
  --workers 1 \
  --timeout-keep-alive 30
