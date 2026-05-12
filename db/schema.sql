-- FinSurf PostgreSQL Schema
-- Run once: psql $DATABASE_URL -f db/schema.sql
-- Requires: pgcrypto extension (gen_random_uuid)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────────
--  USERS
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 VARCHAR(255) UNIQUE NOT NULL,
  username              VARCHAR(50)  UNIQUE,            -- auto-generated from email prefix
  role                  VARCHAR(20)  NOT NULL DEFAULT 'user', -- 'user' | 'admin'
  password_hash         VARCHAR(255),           -- NULL for OAuth-only accounts
  display_name          VARCHAR(100),
  avatar_url            TEXT,
  is_verified           BOOLEAN      NOT NULL DEFAULT FALSE,
  is_active             BOOLEAN      NOT NULL DEFAULT TRUE,
  -- MFA
  mfa_enabled           BOOLEAN      NOT NULL DEFAULT FALSE,
  mfa_secret            VARCHAR(200),           -- encrypted TOTP secret
  -- Security
  failed_login_attempts INTEGER      NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  -- GDPR
  data_export_requested BOOLEAN      NOT NULL DEFAULT FALSE,
  deletion_requested_at TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email    ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- ─────────────────────────────────────────────────
--  OAUTH ACCOUNTS (Google / Apple / Microsoft)
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_accounts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        VARCHAR(50) NOT NULL,   -- 'google' | 'apple' | 'microsoft'
  provider_user_id VARCHAR(255) NOT NULL,
  access_token    TEXT,
  refresh_token   TEXT,
  token_expires_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, provider_user_id)
);

-- ─────────────────────────────────────────────────
--  REFRESH TOKENS  (HTTP-only cookie store)
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(255) NOT NULL UNIQUE,  -- SHA-256 of the raw token
  device_info JSONB,
  ip_address  INET,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- ─────────────────────────────────────────────────
--  PASSWORD RESET TOKENS  (single-use, 1 h TTL)
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_resets (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────
--  EMAIL VERIFICATION TOKENS
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_verifications (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(255) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────
--  AUTH AUDIT LOG  (GDPR-compliant, no passwords)
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_logs (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
  event      VARCHAR(60) NOT NULL,  -- login_success | login_failed | logout | register |
                                    -- password_reset_request | password_reset_success |
                                    -- token_refresh | account_locked | mfa_enabled
  ip_address INET,
  user_agent TEXT,
  metadata   JSONB,                 -- e.g. { "reason": "wrong_password", "attempt": 3 }
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_logs_user ON auth_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_logs_event ON auth_logs(event);
CREATE INDEX IF NOT EXISTS idx_auth_logs_created ON auth_logs(created_at DESC);

-- ─────────────────────────────────────────────────
--  PORTFOLIOS  (one user → many portfolios)
-- ─────────────────────────────────────────────────
CREATE TYPE portfolio_type AS ENUM (
  'brokerage', 'roth_ira', 'traditional_ira', '401k', '403b',
  'mutual_fund', 'crypto', 'hsa', 'paper', 'cash', 'other'
);

CREATE TYPE tax_status AS ENUM ('taxable', 'tax_deferred', 'tax_exempt');

CREATE TABLE IF NOT EXISTS portfolios (
  id                  UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                VARCHAR(100)   NOT NULL,
  type                portfolio_type NOT NULL DEFAULT 'brokerage',
  description         TEXT,
  currency            VARCHAR(10)    NOT NULL DEFAULT 'USD',
  tax_status          tax_status     NOT NULL DEFAULT 'taxable',
  custodian           VARCHAR(100),           -- 'Fidelity', 'Schwab', 'Robinhood', etc.
  cash_balance        DECIMAL(18,4)  NOT NULL DEFAULT 0,
  color               VARCHAR(7)     NOT NULL DEFAULT '#00ffcc',  -- UI accent hex
  icon                VARCHAR(50),
  is_default          BOOLEAN        NOT NULL DEFAULT FALSE,
  is_archived         BOOLEAN        NOT NULL DEFAULT FALSE,
  -- Multi-tenant sharing
  visibility          VARCHAR(20)    NOT NULL DEFAULT 'private', -- 'private'|'public'|'followers_only'
  is_system           BOOLEAN        NOT NULL DEFAULT FALSE,     -- TRUE for admin's portfolio
  is_featured         BOOLEAN        NOT NULL DEFAULT FALSE,     -- promoted by admin
  copy_trade_enabled  BOOLEAN        NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portfolios_user       ON portfolios(user_id);
CREATE INDEX IF NOT EXISTS idx_portfolios_visibility ON portfolios(visibility) WHERE is_archived = FALSE;

-- Enforce single default per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolios_default
  ON portfolios(user_id) WHERE is_default = TRUE AND is_archived = FALSE;

-- ─────────────────────────────────────────────────
--  PORTFOLIO SHARES  (explicit grants to other users)
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS portfolio_shares (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id        UUID        NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  shared_with_user_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission          VARCHAR(20) NOT NULL DEFAULT 'view',  -- 'view' | 'copy_trade'
  expires_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(portfolio_id, shared_with_user_id)
);

CREATE INDEX IF NOT EXISTS idx_portfolio_shares_portfolio ON portfolio_shares(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_shares_user      ON portfolio_shares(shared_with_user_id);

-- ─────────────────────────────────────────────────
--  ACCESS LOGS  (portfolio view/edit audit trail)
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS access_logs (
  id                  BIGSERIAL   PRIMARY KEY,
  actor_user_id       UUID        REFERENCES users(id) ON DELETE SET NULL,
  target_portfolio_id UUID        REFERENCES portfolios(id) ON DELETE SET NULL,
  action              VARCHAR(50) NOT NULL,  -- 'view_public'|'view_private'|'edit'|'admin_view'|...
  ip_address          INET,
  metadata            JSONB       NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_access_logs_portfolio ON access_logs(target_portfolio_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_logs_actor     ON access_logs(actor_user_id, created_at DESC);

-- ─────────────────────────────────────────────────
--  PUBLIC PORTFOLIO VIEW
-- ─────────────────────────────────────────────────
CREATE OR REPLACE VIEW public_portfolio_view AS
SELECT
  p.id, p.name, p.description, p.visibility, p.copy_trade_enabled,
  p.color, p.is_featured, p.created_at, p.updated_at,
  u.id   AS user_id,
  u.username,
  u.display_name,
  COUNT(h.id) AS holding_count
FROM portfolios p
JOIN  users    u ON u.id = p.user_id
LEFT JOIN holdings h ON h.portfolio_id = p.id
WHERE p.visibility = 'public' AND p.is_archived = FALSE AND u.is_active = TRUE
GROUP BY p.id, u.id;

-- ─────────────────────────────────────────────────
--  HOLDINGS  (one portfolio → many holdings)
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS holdings (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id   UUID          NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  symbol         VARCHAR(20)   NOT NULL,
  name           VARCHAR(255),
  shares         DECIMAL(18,6) NOT NULL DEFAULT 0,
  avg_cost_basis DECIMAL(18,4) NOT NULL DEFAULT 0,
  sector         VARCHAR(100),
  asset_class    VARCHAR(50)   DEFAULT 'equity',  -- equity|etf|bond|crypto|cash|option
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE(portfolio_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_holdings_portfolio ON holdings(portfolio_id);

-- ─────────────────────────────────────────────────
--  TRANSACTIONS  (audit trail for every trade)
-- ─────────────────────────────────────────────────
CREATE TYPE tx_type AS ENUM (
  'BUY', 'SELL', 'DIVIDEND', 'CONTRIBUTION', 'WITHDRAWAL',
  'FEE', 'TRANSFER_IN', 'TRANSFER_OUT', 'SPLIT'
);

CREATE TABLE IF NOT EXISTS transactions (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID          NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  holding_id   UUID          REFERENCES holdings(id) ON DELETE SET NULL,
  type         tx_type       NOT NULL,
  symbol       VARCHAR(20),
  shares       DECIMAL(18,6),
  price        DECIMAL(18,4),
  amount       DECIMAL(18,4) NOT NULL,  -- total value of transaction
  fees         DECIMAL(18,4) NOT NULL DEFAULT 0,
  notes        TEXT,
  executed_at  TIMESTAMPTZ   NOT NULL,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tx_portfolio ON transactions(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_tx_executed  ON transactions(executed_at DESC);

-- ─────────────────────────────────────────────────
--  WATCHLISTS  (per user)
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watchlists (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       VARCHAR(100) NOT NULL DEFAULT 'My Watchlist',
  symbols    TEXT[]       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_watchlists_user ON watchlists(user_id);

-- ─────────────────────────────────────────────────
--  PRICE ALERTS  (per user × symbol)
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alerts (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  portfolio_id UUID          REFERENCES portfolios(id) ON DELETE CASCADE,
  symbol       VARCHAR(20)   NOT NULL,
  condition    VARCHAR(20)   NOT NULL,   -- 'above' | 'below' | 'pct_change'
  target_value DECIMAL(18,4) NOT NULL,
  note         TEXT,
  is_active    BOOLEAN       NOT NULL DEFAULT TRUE,
  triggered_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id);

-- ─────────────────────────────────────────────────
--  updated_at trigger helper
-- ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER users_updated_at       BEFORE UPDATE ON users       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER portfolios_updated_at  BEFORE UPDATE ON portfolios  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER holdings_updated_at   BEFORE UPDATE ON holdings    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER watchlists_updated_at BEFORE UPDATE ON watchlists  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────
--  AI-TRADER INTEGRATION
-- ─────────────────────────────────────────────────

ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_trader_token      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_trader_agent_id   INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_trader_registered_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS ai_trader_signals (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at_signal_id   VARCHAR(100),              -- ID returned by AI-Trader API
  symbol         VARCHAR(20)  NOT NULL,
  action         VARCHAR(20)  NOT NULL,     -- buy | sell | short | cover
  price          DECIMAL(18,4),
  quantity       INTEGER,
  analysis       TEXT,
  followers      INTEGER      NOT NULL DEFAULT 0,
  published_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signals_user   ON ai_trader_signals(user_id);
CREATE INDEX IF NOT EXISTS idx_signals_symbol ON ai_trader_signals(symbol);

-- Signal performance columns (C)
ALTER TABLE ai_trader_signals ADD COLUMN IF NOT EXISTS entry_price   DECIMAL(18,4);
ALTER TABLE ai_trader_signals ADD COLUMN IF NOT EXISTS price_1d      DECIMAL(18,4);
ALTER TABLE ai_trader_signals ADD COLUMN IF NOT EXISTS price_7d      DECIMAL(18,4);
ALTER TABLE ai_trader_signals ADD COLUMN IF NOT EXISTS price_30d     DECIMAL(18,4);
ALTER TABLE ai_trader_signals ADD COLUMN IF NOT EXISTS pnl_1d        DECIMAL(8,4);
ALTER TABLE ai_trader_signals ADD COLUMN IF NOT EXISTS pnl_7d        DECIMAL(8,4);
ALTER TABLE ai_trader_signals ADD COLUMN IF NOT EXISTS pnl_30d       DECIMAL(8,4);
ALTER TABLE ai_trader_signals ADD COLUMN IF NOT EXISTS checked_1d_at  TIMESTAMPTZ;
ALTER TABLE ai_trader_signals ADD COLUMN IF NOT EXISTS checked_7d_at  TIMESTAMPTZ;
ALTER TABLE ai_trader_signals ADD COLUMN IF NOT EXISTS checked_30d_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS ai_trader_notifications (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(50) NOT NULL,   -- new_follower | discussion_reply | strategy_reply_accepted
  data       JSONB       NOT NULL DEFAULT '{}',
  is_read    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_at_notifs_user ON ai_trader_notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_trader_following (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leader_id    VARCHAR(100) NOT NULL,
  leader_name  VARCHAR(200),
  followed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, leader_id)
);

CREATE INDEX IF NOT EXISTS idx_at_following_user ON ai_trader_following(user_id);
