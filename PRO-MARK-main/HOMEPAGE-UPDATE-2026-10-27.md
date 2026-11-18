# ZELIMU CBC public homepage update — 27 October 2026

## What changed
- Replaced the minimal root `public/index.html` with a responsive public-facing landing page inspired by the reference screenshot's overall flow, while retaining ZELIMU CBC branding and original logo.
- The root route remains the public homepage. Existing `/login.html`, `/dashboard.html`, and `/owner.html` paths are unchanged.
- Added feature overview, eight-module overview, role portal descriptions, login calls to action, mobile navigation, and responsive layouts.
- The onboarding copy explains that new schools should contact the platform administrator; no registration API is invented.
- No database files or live services were changed.

## Validation
- `node --check backend/server.js` passed.
- `node --check backend/routes/finance.js` passed.
- `npm run check` passed (59 JavaScript files checked).
- Full browser and live deployment tests remain to be performed.

## Notes
The homepage describes planned workflows carefully and does not claim that external integrations such as live M-Pesa, SMS, biometrics, or GPS tracking are already connected. Confirm the official onboarding contact before publishing contact details.
