# Automation — FinSurfing

## AI Agents / LLM Surfaces

---

### 1. Copilot Chat (`POST /api/copilot/chat`)

**Trigger:** User message in the Copilot UI  
**Owner:** Request-scoped (per HTTP call)  
**Automatic:** Yes — fires on every chat message; no approval gate  
**Auth:** None (rate-limited at 30/min/IP only)

**Inputs the agent may read:**
- `messages[]` — full conversation history from the client body (user-controlled)
- `portfolio[]`, `watchlist[]` — symbol lists from client body (user-controlled)
- `providerId`, `providerState` — provider selection including `baseUrl` (user-controlled; **security risk — see security audit**)

**Tools / APIs the agent may call:**
| Tool | Internal endpoint | Side effect |
|---|---|---|
| `scan_market` | POST /api/ai-brain/analyze | Paid Claude/Groq call |
| `get_recommendations` | POST /api/recommendations | Paid Claude/Groq call |
| `analyze_symbol` | POST /api/trading-analysis/analyze + GET /api/quote | Paid Claude call |
| `get_social_sentiment` | Reddit API (via lib/social-sentiment) | External HTTP |
| `get_macro` | GET /api/macro/summary | FRED API |
| `get_earnings_catalyst` | GET /api/earnings/date + /api/earnings/positioning | FMP API |
| `get_options_flow` | GET /api/options/flow | External data provider |

**Steering (prompt):** `COPILOT_SYSTEM` constant in `routes/copilot.js:52–124`  
**Hard guardrails:** None enforced outside the prompt. Tool dispatch does not prevent arbitrary tools from being called.  
**Output contract:** SSE events (`text`, `tool_start`, `tool_results`, `done`, `error`)  
**App-owned vs agent-owned:** Agent synthesizes and streams text. App enforces no output schema. All output is advisory.  
**Approval gate:** None  
**Audit logging:** None — no conversation stored  
**Rate limit:** 30 requests/min/IP  
**Kill switch:** Remove `ANTHROPIC_API_KEY` env var (disables all Claude calls; Groq fallback remains)

---

### 2. Trading Analysis (`POST /api/trading-analysis/analyze`)

**Trigger:** User clicks "Analyze" in TradingAIPanel; also called by Copilot tool and scheduled jobs  
**Owner:** Request-scoped  
**Automatic:** Yes (auto-fires on symbol change in TradingAIPanel)  
**Auth:** `optionalAuth` — guests allowed

**Inputs the agent may read:**
- `symbol` — ticker from body/query (user-controlled; validated by `tvToYahoo`)
- `interval` — chart timeframe (user-controlled; validated by `tvToChartParams`)
- `livePrice` — optional current price (user-controlled number)
- OHLCV chart data from internal `/api/chart`
- Computed TA indicators (pure JS)
- StockTwits sentiment (external API)
- Prior AI memory (DB, scoped to user)

**LLM called:** Claude claude-sonnet-4-6 (primary), Groq fallback  
**Output contract:** Structured JSON `{ signal, confidence, entry, entryZoneLow, entryZoneHigh, stopLoss, takeProfit, riskReward, reasoning, risks, contradictions }`  
**Output validation:** JSON.parse of LLM response with regex extraction fallback; no schema validation  
**App-owned vs agent-owned:** Agent produces analysis JSON. Frontend displays it. No automated trade execution.  
**Approval gate:** None  
**Audit/memory:** Analysis saved to `ai_memory` table (user_id + symbol + timestamp)  
**Kill switch:** Remove `ANTHROPIC_API_KEY`

---

### 3. AI Brain Scanner (`POST /api/ai-brain/analyze`, `POST /api/ai-brain/scan`)

**Trigger:** Copilot `scan_market` tool, scheduled jobs, direct API call  
**Owner:** Request-scoped or scheduled (no user context)  
**Automatic:** Scheduled hourly via `hourlyAiScan`; also directly callable  
**Auth:** None (rate-limited, bypassable via `x-internal` header)

**Multi-agent architecture:** 5 parallel Claude agents (Fundamental, Technical, Sentiment, Macro, Supervisor) each analyzing a symbol universe  
**Inputs:** Symbol list, horizon, optional universe preset  
**Output contract:** `{ rankedStocks[], marketRegime, macroOutlook, agentConsensusTheme }` per stock: `{ symbol, compositeScore, agentVerdict, entryZoneLow/High, targetZoneLow/High, supervisorSynthesis, bearCase }`  
**Kill switch:** Remove `ANTHROPIC_API_KEY`

---

### 4. Recommendations (`POST /api/recommendations`)

**Trigger:** Direct API call, Copilot `get_recommendations` tool  
**Auth:** None  
**Inputs:** `persona` (validated against enum), `includeMacro` flag, `focusSymbols[]`  
**LLM called:** Claude (primary), Groq fallback  
**Output:** 20 personalized buy signals with entry/target/stop  
**Approval gate:** None  
**Kill switch:** Remove `ANTHROPIC_API_KEY`

---

## Controls Summary

| Control | Status |
|---|---|
| Approval gates before LLM calls | None |
| Output schema validation | Partial (JSON parse + regex, no strict schema) |
| Conversation/tool-call audit log | None |
| Per-user spend cap | None |
| Rate limiting | IP-based only; bypassable on AI Brain |
| `providerState.baseUrl` allowlist | **Missing — critical vulnerability** |
| Prompt injection filtering | None on copilot; basic symbol sanitization on trading-analysis |
| Kill switch | Remove API key env vars |
