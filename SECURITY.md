# Security

Halftime is a hackathon prototype that runs against the PayPal **sandbox** only. Its only access control is one shared staff PIN, so don't deploy it for a real club without adding proper accounts.

If you find a security problem, please don't open a public issue. Use GitHub's private vulnerability reporting on this repository ("Security" tab → "Report a vulnerability"). I'll reply within a few days.

## The staff PIN

Set `STAFF_PIN` on any server other people can reach. Without it every page and API route is open, which is fine on your own laptop, and the server logs a warning the first time it handles a request.

With `STAFF_PIN` set, `proxy.ts` lets these through without the PIN, because a fan's phone needs them:

- the buyer menu (`/m/<game>`) and `/how-it-works`
- creating an order, capturing it, and reading its status (`POST /api/orders`, `POST /api/orders/<id>/capture`, `GET /api/orders/<id>`)
- PayPal's webhook (`POST /api/paypal/webhook`, which checks PayPal's signature itself)
- `/api/health`, the sign-in page `/staff`, and Next's scripts, styles and image files

Everything else needs the PIN: game pages, counts, the cash count, finalizing, deposits, refunds, reimbursements and Payouts, photos (including deposit slips), notices, the season ledger, and "Reset demo data". Pages redirect to `/staff`; API routes answer `401`.

Entering the PIN at `/staff` sets an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over HTTPS) that holds an HMAC-SHA256 of a fixed label keyed by the PIN. It lasts 30 days. Changing `STAFF_PIN` signs every device out. After 10 wrong PINs from one address, sign-in pauses for 15 minutes.

This is a demo-grade gate, not user accounts:

- Everyone on staff shares one PIN, so the audit log records the names people pick from the roster, not who was signed in.
- A device stays signed in until the cookie expires or the PIN changes. There is no per-device sign-out from the server.
- The attempt counter lives in memory and resets when the server restarts.

## Blind cash count

While a game is closing and the two cash counts don't agree yet, no page or API response shows a counted total, the expected cash, or the closing count and per-item numbers that would let someone work it out. `lib/redact.ts` applies this to `GET /api/nights/<id>`, the season ledger hides the expected cash for that game, and the close-out page shows only the items that need a recount. The closing count can't be reopened once the first cash count is saved, and a recount doesn't send the saved leftovers back to the browser. The two volunteers who did the closing count can't count the cash, because the leftovers are enough to work out the expected amount. `GET /api/nights/<id>` also never includes buyers' PayPal or Venmo emails, capture ids, volunteers' or payees' email addresses, or the photo ids of receipts and deposit slips.

## Demo reset

`POST /api/demo/reset` deletes every game and restores the samples. It needs a JSON body `{ "confirm": "reset" }` from the same site, plus the staff cookie when `STAFF_PIN` is set. Set `DEMO_RESET_ENABLED=false` to turn it off entirely.

## In scope

- Ways to change an order's items or total after PayPal captured it
- Webhook events being accepted without signature verification
- Secrets (PayPal client secret, Gemini key, staff PIN) reaching the browser or the logs
- Staff-only routes or blind-count numbers reachable without the PIN
