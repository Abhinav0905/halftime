# Halftime HTTP API

All bodies are JSON unless noted. Errors return `{ "error": string }` with a 4xx/5xx status.
Route handlers wrap their logic in `handle()` from `lib/http.ts` and validate bodies with zod via `readJson()`.
Money is integer cents everywhere. Names (countedBy, checkedBy, …) are free text chosen from the club roster in the UI.

## Night lifecycle

`setup` (waiting for opening count) → `selling` (opening count confirmed; buyer menu takes orders) → `closing` (closing count saved; menu stops taking orders; cash counts allowed) → `closed` (finalized) → `deposited`.

| Method & path | Body | Success | Rules |
|---|---|---|---|
| `POST /api/nights` | `{ title, date: "YYYY-MM-DD", floatCents }` | `201 { id }` | |
| `GET /api/nights/[id]` | | `200 NightState` (see `lib/repo.ts`) | 404 if unknown |
| `GET /api/nights/[id]/events` | | `text/event-stream`; each message `data: <NightEvent JSON>` (`lib/events.ts`); `: ping` comment every 15 s | |
| `POST /api/nights/[id]/photos` | multipart: `file` (jpeg/png/webp ≤ 8 MB), `purpose` = `open`\|`close`\|`slip`\|`receipt` | `201 { sha256, url }` (`url` = `/api/photos/<sha256>`) | stored once per SHA-256 |
| `GET /api/photos/[sha256]` | | image bytes, immutable cache headers | |
| `POST /api/nights/[id]/suggest` | `{ kind: "open"\|"close", sha256 }` | `200 { suggestionId: string\|null, provider: "gemini"\|"replay"\|"manual", model: string\|null, result: CountResult\|null, message?: string }` | never 500 on model failure: returns `result: null` + a plain `message` so the volunteer counts by hand |
| `POST /api/nights/[id]/counts` | `{ kind, counts: {sku:int≥0}, waste?: {sku:int≥0}, countedBy, checkedBy, sha256?, suggestionId? }` | `200 { ok: true, status }` | `checkCountPeople`; every catalog SKU must be present; `open` only while `setup`/`selling` and before the first COMPLETED order (409 "Sales have started, so the opening count is locked."); `close` only while `selling`/`closing`; open → `selling`, close → `closing`; publishes `count.saved` |
| `POST /api/nights/[id]/cash` | `{ countedBy, cents }` | `200 { ok: true, cash: { status, countedCents } }` | only while `closing`; `checkCashCounter`; publishes `cash.counted` |
| `POST /api/nights/[id]/finalize` | `{ by, note? }` | `200 { ok: true, status: "closed" }` | needs close count and cash status `agree`; if recount flags exist a `note` (≥ 10 chars) is required and an amber notice is filed; cash band amber/red files a notice for officers |
| `POST /api/nights/[id]/deposit` | `{ depositor, cents, slipSha256? }` | `200 { ok: true, depositVarianceCents, band }` | only while `closed`; `checkDepositor` against cash counters; → `deposited`; band amber/red files a notice |
| `POST /api/nights/[id]/reimbursements` | `{ requester, payeeEmail, cents, memo, receiptSha256? }` | `201 { id }` | email format, cents > 0 and ≤ 50000 |
| `POST /api/reimbursements/[rid]/approve` | `{ approver }` | `200 { status, payoutStatus, batchId }` | `checkApprover` (opening count must exist); sends PayPal Payouts with `sender_batch_id = rid`; if already sent, returns current state without re-sending |
| `POST /api/reimbursements/[rid]/refresh` | | `200 { status, payoutStatus }` | GET payout item from PayPal |
| `POST /api/notices/[id]/read` | | `200 { ok: true }` | |
| `POST /api/demo/reset` | | `200 { ok: true }` | re-seeds sample data; disabled when `DEMO_RESET_ENABLED=false` |

## Payments

| Method & path | Body | Success | Rules |
|---|---|---|---|
| `POST /api/orders` | `{ nightId, booth?: string (default "window"), cart: { sku: qty } }` | `201 { id, code, totalCents, simulated }` | night must be `selling` (409 otherwise). Server prices the cart (`buildOrderRequest`), creates the PayPal order with `PayPal-Request-Id`, stores it as CREATED with a 3-char pickup `code`. If PayPal credentials are missing, returns a `SIM-…` id with `simulated: true`. |
| `POST /api/orders/[id]/capture` | `{ mockDecline?: boolean }` | `200 { status: "COMPLETED", code, items, totalCents }` or `402 { status: "DECLINED", issue, code }` | Captures, then GETs the order and stores PayPal's own line items and total. `INSTRUMENT_DECLINED` → 402 so the buyer button can call `actions.restart()`. Idempotent: capturing an already COMPLETED order returns it. `mockDecline` sends `PayPal-Mock-Response: {"mock_application_codes":"INSTRUMENT_DECLINED"}` (sandbox negative testing). Publishes `order.paid` / `order.declined`. |
| `POST /api/orders/[id]/refund` | `{ by }` | `200 { status: "REFUNDED", refundId }` | full refund of the capture with `PayPal-Request-Id = refund-<orderId>`; units leave the PayPal column immediately; publishes `order.refunded` |
| `POST /api/paypal/webhook` | PayPal event | `200` | verifies with `POST /v1/notifications/verify-webhook-signature` using `PAYPAL_WEBHOOK_ID`; stores event id once (duplicates ignored); handles `PAYMENT.CAPTURE.COMPLETED` (backfills via GET order), `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.PAYOUTS-ITEM.*` |

## CountResult (vision output, validated with zod)

```ts
{
  items: { sku: string; count: number; confidence: "high" | "medium" | "low"; boxes: [number, number, number, number][] }[]; // boxes: [ymin, xmin, ymax, xmax] on a 0–1000 grid
  unknown: { label: string; count: number }[];   // things on the table that are not on the menu
  quality: string[];                              // e.g. "items stacked", "glare", "table edge cut off"
}
```
