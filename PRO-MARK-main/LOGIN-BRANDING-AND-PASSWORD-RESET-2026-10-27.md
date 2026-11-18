# ZELIMU CBC Login Branding and Password Recovery

## Included
- Responsive, professional login page with ZELIMU CBC branding and clear email/password flow.
- Multiple-role / school selection retained.
- Remember-me preference checkbox retained as a UI preference only; session lifetime remains governed by the existing API token.
- Forgot-password request and reset-password page.
- One-time random reset token, SHA-256 hash stored in PostgreSQL, 30-minute expiry, one-time use, bcrypt password hashing.
- Generic response for unknown email addresses to reduce account enumeration.

## Required Render environment variables for email delivery
Set these on the Render web service before expecting self-service reset emails:
- `RESEND_API_KEY`: API key from Resend.
- `PASSWORD_RESET_FROM`: sender address verified in Resend, e.g. `ZELIMU CBC <accounts@your-verified-domain>`.
- `APP_BASE_URL`: public app origin, e.g. `https://your-service.onrender.com` (no trailing slash required).

Without these settings, the forgot-password API explicitly tells the user self-service reset is not configured and directs them to their school administrator. No password or reset token is exposed in the browser response. The reset token table is created lazily by the API when requested; no data migration is required.

## Checks
- `node --check backend/routes/auth.js`
- `node --check backend/server.js`
- Inline scripts in `public/login.html` and `public/reset-password.html` syntax checked.
- `npm run check` passed.

No live Render, email-provider, or Supabase integration test was run. Configure the environment variables and test using a controlled account before announcing self-service password reset as live.
