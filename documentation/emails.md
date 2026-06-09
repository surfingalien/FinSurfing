# Emails — FinSurfing

## Send Path

```
Application code
  → lib/email.js:sendEmail()
  → RESEND_API_KEY set?  → Resend API (https://api.resend.com/emails)
  → SMTP configured?     → nodemailer (SMTP_HOST + SMTP_USER + SMTP_PASS)
  → Neither              → console.log only (demo/dev mode)
```

`RESEND_FROM` controls the "From" address (default: `FinSurf <noreply@finsurf.app>`).

## Email Inventory

| Trigger | Subject | Template inputs | Sent from | Risk |
|---|---|---|---|---|
| User registration | "FinSurf — Your verification code" | `code` (6-digit OTP) | `lib/email.js` | OTP exposed in API response if no email service configured |
| Resend verification | "FinSurf — Your verification code" | `code` | `lib/email.js` | Same |
| Forgot password | "FinSurf — Password reset" | `link` (reset URL with token) | `routes/auth.js` | Link logged to console if no SMTP |
| Morning brief (scheduled) | "FinSurf 3–6M Picks — {date} | {regime}" | Stock table, macro signals, AI scores | `lib/scheduled-jobs.js` | Only sent if `MORNING_BRIEF_EMAIL` or `ADMIN_EMAIL` set |

## Template Security Notes

- OTP email: `code` is a numeric string — no HTML injection risk.
- Password reset email: `link` is built from `APP_URL` env var + `/reset-password?token=<hex>`. The token is 64 hex chars. **`APP_URL` defaults to `http://localhost:5173` if unset** — reset links point to localhost in production if `APP_URL` is not set.
- Morning brief: HTML is built in `lib/scheduled-jobs.js:buildMorningBriefHtml()`. Template inputs come from AI Brain / FRED API responses, not directly from user input. No user-controlled strings.

## Retry / Backoff

None. Sends are single-attempt. Failures throw an error caught by the caller:
- Auth routes: registration/login succeed even if email fails (OTP appears in response or is logged)
- Morning brief: exception propagates to scheduler, job marked `failed`

## Where to Look When Send Fails

1. Railway logs for `[EMAIL]` prefix (console fallback) or error stack traces
2. Resend dashboard (if `RESEND_API_KEY` is set)
3. `GET /api/scheduler/jobs` → `morning-brief-email` result.error field
