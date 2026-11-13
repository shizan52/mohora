# Security

## Reporting a problem

Please don't open a public issue for a security problem. Use GitHub's private reporting instead:
**Security** tab → **Report a vulnerability**.

## How the project handles sensitive data

- **API keys** the user connects stay in their browser and go straight to the AI provider. The server never stores them. The optional relay (`/api/relay`) forwards a key for one request and neither logs nor saves it.
- **CVs and job descriptions** are read in the browser and sent only to the user's chosen AI.
- **Admins can't read transcripts.** The admin panel shows counts, scores and metadata.
- **Sessions** use signed, HttpOnly, SameSite=Lax cookies (Secure on https). Every request that changes data carries a CSRF token.
- **Security headers** include a strict Content-Security-Policy, `X-Content-Type-Options`, `Referrer-Policy` and a restrictive `Permissions-Policy`.
- **Payments** are checked against the TRON blockchain by transaction ID. No wallet keys are ever held by the app.

## If you run your own copy

- Set a long random `SECRET_KEY`. The site refuses to start on an https address with the example value.
- Keep port 8000 off the public internet; let only Caddy or your own proxy reach it.
- Use the Google OAuth client's authorized redirect URI list to allow only your own domain.
- Back up the data volume (the compose file does this daily) and test a restore once.
