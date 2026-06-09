# Permissions — FinSurfing

## Roles

| Role | How assigned | Notes |
|---|---|---|
| `guest` | No token | Unauthenticated — can read market data, use AI features |
| `user` | Registered + verified | Can manage own portfolios and holdings |
| `admin` | `ADMIN_EMAIL` env var match at registration | Full access; pre-seeded portfolio visible only to admin |

Role is embedded in JWT (`role` claim) and re-checked on each request where it matters.

## Resource × Operation × Role Matrix

| Resource | Operation | guest | user | admin | Notes |
|---|---|---|---|---|---|
| Market quotes / charts | Read | ✅ | ✅ | ✅ | Rate-limited; no auth required |
| News, search | Read | ✅ | ✅ | ✅ | |
| AI analysis (trading-analysis) | POST | ❌ | ✅ | ✅ | `requireAuth` — authenticated users only |
| Copilot chat | POST | ❌ | ✅ | ✅ | `requireAuth` + rate-limited at 30/min |
| AI Brain scan | POST | ✅ | ✅ | ✅ | No auth required; rate-limited (loopback bypasses) |
| Recommendations | POST | ✅ | ✅ | ✅ | No auth required |
| Macro indicators | GET | ✅ | ✅ | ✅ | |
| Own portfolio | CRUD | ❌ | ✅ | ✅ | `requireAuth` |
| Other user's portfolio (public) | Read | ✅ | ✅ | ✅ | Only `visibility='public'` |
| Other user's portfolio (private) | Read | ❌ | ❌ | ✅ | Admin-only via admin routes |
| Scheduler jobs — list | GET | ✅ | ✅ | ✅ | **No auth** — exposes job metadata |
| Scheduler jobs — trigger | POST | ❌ | ❌ | ✅ | `requireAuth + requireAdmin` |
| Scheduler jobs — enable/disable | PATCH | ❌ | ❌ | ✅ | `requireAuth + requireAdmin` |
| Admin routes (`/api/admin/*`) | All | ❌ | ❌ | ✅ | `requireAuth + requireAdmin` |
| Auth (register, login, verify) | POST | ✅ | ✅ | ✅ | Rate-limited |
| Own profile | GET/PATCH | ❌ | ✅ | ✅ | `requireAuth` |
| Change password | POST | ❌ | ✅ | ✅ | `requireAuth` |
| Research notes | CRUD | ❌ | ✅ | ✅ | `requireAuth` |
| AI memory | Read | ❌ | ✅ | ✅ | `requireAuth` (optional on writes) |

## Database Row-Level Security

PostgreSQL RLS is **not enabled**. Authorization is enforced in application code only.

Key enforced checks (code-level):
- `routes/portfolios.js`: All portfolio queries filter on `user_id = req.user.userId` — prevents cross-user access.
- `routes/research-notes.js`: Notes scoped to `req.user.userId`.
- `routes/trading-analysis.js`: AI memory queries scoped to `req.user?.userId` (optional auth).

**No RLS means:** if a query bug omits the `user_id` filter, Postgres will return all rows. There is no database-layer catch.

## Scope Derivation

- Access token claims (`sub`, `email`, `role`) are set at login and embedded in JWT.
- Token is verified on every `requireAuth` / `optionalAuth` call; no DB lookup is performed for access tokens.
- Refresh tokens are stored hashed in DB (or in-memory); rotated on every use.
