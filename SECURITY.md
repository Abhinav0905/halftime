# Security

Halftime is a hackathon prototype that runs against the PayPal **sandbox** only. It has no sign-in yet, so don't deploy it for a real club without adding authentication.

If you find a security problem, please don't open a public issue. Use GitHub's private vulnerability reporting on this repository ("Security" tab → "Report a vulnerability"). I'll reply within a few days.

Things that are in scope:

- Ways to change an order's items or total after PayPal captured it
- Webhook events being accepted without signature verification
- Secrets (PayPal client secret, Gemini key) reaching the browser or the logs
