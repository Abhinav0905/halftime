# Halftime HTTP API

## Conventions

- Bodies are JSON unless noted. Errors return `{ "error": string }` with a 4xx or 5xx status.
- Route handlers wrap their logic in `handle()` from `lib/http.ts`. An `HttpError` becomes `{ error }` with its status; anything else is logged and answered with 500 "Something went wrong on the server. Please try again."
- Bodies are validated with zod through `readJson()`. A body that isn't JSON gets 400 "Expected a JSON body."; a field that fails validation gets 400 `"<field>: <message>"`.
- Money is integer cents everywhere.
- **Size limits.** JSON bodies stop at 64 KB (`MAX_JSON_BYTES`) and get 413 "The request is too large." The same 64 KB applies to the capture body and to webhook events (413 "That is too large to be a PayPal webhook event."). Photo uploads stop at 8 MB plus 64 KB for the multipart wrapping, and the file itself at 8 MB (413 "The photo is larger than 8 MB."). Bytes are counted as they arrive, so a chunked upload without `Content-Length` is cut off at the limit too. Because `proxy.ts` runs on every request, Next holds each body in memory up to `experimental.proxyClientMaxBodySize` (8.5 MB, `next.config.ts`); a larger body reaches the route cut off at that size and still gets the 413.
- **Names come from the club roster.** Every name field (`countedBy`, `checkedBy`, `by`, `depositor`, `requester`, `approver`) must match someone in the roster (`lib/roster.ts`). Matching ignores case, repeated or surrounding spaces and Unicode width forms (NFKC), and the server stores the roster spelling, so "marcus  hill" is the same person as "Marcus Hill". A name nobody on the roster matches gets 400 "`<label>` has to be someone on the club roster." Separation-of-duty checks compare these roster spellings.
- **Sample games** (`night.sample = true`, seeded by `lib/seed.ts`) are read-only: refunds and reimbursements on them get 409. Their status is `deposited`, so the count, cash, finalize and deposit rules already refuse changes.

## Access and the staff PIN

`proxy.ts` and `lib/staff.ts`.

- **`STAFF_PIN` unset:** every page and route is open. The server logs a warning once per process.
- **`STAFF_PIN` set:** only these are public. A trailing slash is ignored.

| Public without the PIN | Methods |
|---|---|
| `/m/<id>` (buyer menu), `/how-it-works`, `/staff` (sign-in page) | any |
| `/api/staff` | any |
| `/api/health` | GET, HEAD |
| `/api/orders` | POST |
| `/api/orders/<id>/capture` | POST |
| `/api/orders/<id>` | GET, HEAD |
| `/api/paypal/webhook` | POST |
| Next's scripts and styles under `/_next/` (not `/_next/image`, which could fetch `/api/photos` for the caller) | any |
| Image files outside `/api/` (`.ico .png .jpg .jpeg .gif .svg .webp .avif .webmanifest`), e.g. `/demo/open.jpg` | any |

Anything else without a valid `halftime_staff` cookie: API routes answer `401 { "error": "Staff only. Enter the club's staff PIN first." }` with `cache-control: no-store`, and pages redirect to `/staff?next=<path and query>`. That includes refunds, reimbursements, photos, counts, the night state and the event stream.

| Method & path | Body | Success | Rules |
|---|---|---|---|
| `GET /api/staff` | | `200 { pinRequired: boolean, signedIn: boolean }` | `signedIn` is true when no PIN is set |
| `POST /api/staff` | `{ pin: string (≤ 200), next?: string (≤ 2000) }` | `200 { ok: true, pinRequired, next }` | No PIN set: always 200 with `pinRequired: false`. PIN set: a match sets the `halftime_staff` cookie (HMAC-SHA256 of a fixed label keyed by the PIN; `HttpOnly`, `SameSite=Lax`, `Path=/`, 30 days, `Secure` when the request or `x-forwarded-proto` is https). Wrong PIN → 401 "That PIN doesn't match. Check it with the club treasurer." After 10 wrong PINs from one client within 15 minutes → 429 "Too many tries. Wait 15 minutes, then try again." The client is the last `x-forwarded-for` hop. `next` is reduced to a same-origin path; `/staff`, `/api/…`, `//…` and anything with control characters or backslashes become `/` |
| `DELETE /api/staff` | | `200 { ok: true }` | clears the cookie on this device |

## Night lifecycle

`setup` (waiting for the opening count) → `selling` (opening count saved; the buyer menu takes orders) → `closing` (closing count saved; no new orders or captures; cash counts allowed) → `closed` (finalized) → `deposited`.

| Method & path | Body | Success | Rules |
|---|---|---|---|
| `POST /api/nights` | `{ title: string (1–80), date: "YYYY-MM-DD", floatCents: int 0–100000 }` | `201 { id }` | the date must exist |
| `GET /api/nights/[id]` | | `200 ClientNightState` (`lib/redact.ts`) | 404 if unknown. See [Night state redaction](#night-state-redaction) |
| `GET /api/nights/[id]/events` | | `text/event-stream`. First frame `retry: 3000`, then one `data: <NightEvent JSON>` per event (`lib/events.ts`), and a `: ping` comment every 15 s | 404 JSON if unknown. Events: `order.paid`, `order.declined`, `order.refunded`, `count.saved`, `cash.counted`, `night.status`, `reimbursement.updated`; none carries an amount of cash |
| `POST /api/nights/[id]/photos` | multipart: `file`, `purpose` = `open`\|`close`\|`slip`\|`receipt` | `201 { sha256, url }` (`url` = `/api/photos/<sha256>`) | 404 if unknown night. The type comes from the file's bytes: JPEG, PNG or WebP, otherwise 415 (also 415 when the upload declares another `image/*` type). Empty file → 400. Stored once per SHA-256 |
| `GET /api/photos/[sha256]` | | image bytes with `etag`, `x-content-type-options: nosniff` and `cache-control: private, max-age=31536000, immutable` (private, so shared caches don't keep staff photos) | 400 unless 64 hex characters (case-insensitive); 304 for a matching `If-None-Match`; 404 if not stored |
| `POST /api/nights/[id]/suggest` | `{ kind: "open"\|"close", sha256 }` | `200 { suggestionId: string\|null, provider: "gemini"\|"replay"\|"manual", model: string\|null, result: CountResult\|null, message?: string }` | 404 if the night or photo is unknown. Never 500 on a model failure: `result: null` plus a plain `message` so the volunteer counts by hand. Unless the provider is `manual`, the latest stored suggestion for the same night, kind and photo is returned again without a new model call. Replay (no `GEMINI_API_KEY`, or `VISION_PROVIDER=replay`) reads `eval/recorded/<sha256>.json` (or `HALFTIME_RECORDED`); with no recording it answers `provider: "manual"`, `result: null`. Live Gemini calls are limited to 12 per game and 60 across all games per hour (`lib/vision/index.ts`, in memory); past that, or when the call fails, a recording is used if there is one |
| `POST /api/nights/[id]/counts` | `{ kind: "open"\|"close", counts: {sku: int 0–9999}, waste?: {sku: int 0–9999}, countedBy, checkedBy, sha256?, suggestionId? }` | `200 { ok: true, status }` | See [Counts](#counts) |
| `POST /api/nights/[id]/cash` | `{ countedBy, cents: int 0–10000000 }` | `200 { ok: true, cash: { status: "missing"\|"single"\|"disagree"\|"agree", countedCents: number\|null } }` | See [Cash counts](#cash-counts) |
| `POST /api/nights/[id]/finalize` | `{ by, note?: string (≤ 1000) }` | `200 { ok: true, status: "closed" }` | 409 "This night is already closed." when `closed` or `deposited`; 409 "Save the closing count before closing the night." while the night isn't `closing` or has no closing count. 409 unless the cash status is `agree`, with a message for `missing`, `single` or `disagree`. If any item is flagged for recount, a `note` of at least 10 characters is required (400), and an amber notice with the note is filed. A cash difference in the amber or red band files a notice for the officers. Publishes `night.status` |
| `POST /api/nights/[id]/deposit` | `{ depositor, cents: int 0–10000000, slipSha256?: 64 hex }` | `200 { ok: true, depositVarianceCents, band }` | 400 if the slip photo was not uploaded. 409 "The deposit for this night is already recorded." when `deposited`, 409 "Close the night before recording the deposit." unless `closed`. The depositor can't be anyone who counted the cash (400). Expected deposit = counted cash − float, never below $0.00. → `deposited`; a difference in the amber or red band files a notice. Publishes `night.status` |
| `POST /api/notices/[id]/read` | | `200 { ok: true }` | 404 if unknown; marking twice is a no-op |
| `POST /api/demo/reset` | `{ "confirm": "reset" }` | `200 { ok: true }` | Deletes every game and restores the samples. 403 when `DEMO_RESET_ENABLED=false`. 415 unless `Content-Type` is `application/json`. 403 when an `Origin` header is present and its host differs from `x-forwarded-host` (or `Host`). 400 without the confirm body. Needs the staff cookie when `STAFF_PIN` is set |
| `GET /api/health` | | `200 { ok: true, paypal: "sandbox"\|"offline-demo", photoCount: "gemini"\|"replay"\|"manual" }` | |

### Counts

- `countedBy` and `checkedBy` must be two different people from the roster (400 "A second volunteer has to check the count.").
- `counts` must have every menu SKU and nothing else (400 "Enter a count for every item. Missing: …" / "Not on the menu: …").
- `waste` is only for the closing count; non-zero waste on an opening count gets 400. Missing waste SKUs count as 0.
- `suggestionId` must belong to this night and kind (400). If both `sha256` and `suggestionId` are sent, they must name the same photo (400). The photo must have been uploaded (400). When a suggestion is used, the differences between it and the saved count go into the audit log.
- **Opening count:** only while `setup` or `selling` and before any order is COMPLETED or REFUNDED, otherwise 409 "Sales have started, so the opening count is locked." Moves the night to `selling`. Any item counted as 0 is not on sale that night (see `POST /api/orders`).
- **Closing count:** 409 "Save the opening count before the closing count." while `setup`; 409 once the night is `closed` or `deposited`. Allowed while `selling` or `closing` until the first cash count is saved; after that, 409 "The cash box has been counted, so the closing count is locked. If a count was off, add a note when you finalize the night." Recount flagged items before anyone counts the cash. Moves the night to `closing`, which stops the buyer menu.
- Saving a count again replaces the earlier one; the audit log keeps the replaced values.
- Publishes `count.saved`, and `night.status` when the status changes.

### Cash counts

- Only while `closing`: 409 "Save the closing count before counting the cash box." during `setup`/`selling`, 409 "This night is already closed." after.
- The two volunteers who counted and checked the closing count can't count the cash (400 "The two volunteers who did the closing count can't count the cash. Ask someone else to count it."). They know the leftovers, and with them the expected amount.
- Two counts in a row can't be by the same person (400 "The next cash count has to be done by a different volunteer.").
- Once two different people have reached the same total, the count is done: further counts get 409. A third count settles a disagreement (A $500, B $400, C $500 agrees on $500).
- `countedCents` stays `null` until the counts agree, so neither counter learns the other's number. The amount is never written to the audit log. Publishes `cash.counted`.

### Night state redaction

`GET /api/nights/[id]` returns `ClientNightState`, which is `NightState` (`lib/repo.ts`) passed through `redactNightState()`. Staff pages render on the server from the full `NightState`; anything a browser can fetch as JSON goes through the redaction.

- Always `null`: `orders[].payer`, `orders[].captureId`, `people[].email`, `reimbursements[].payeeEmail`, `reimbursements[].receiptSha256` and `deposit.slipSha256`.
- `cashHidden` is true while the night is `closing` and the cash status isn't `agree`. Then these are `null`: `close.counts`, `close.waste`, every `cashCounts[].cents`, each recon line's `close`, `sold`, `cashUnits` and `cashCents`, and the recon totals `soldUnits`, `cashUnits`, `expectedCashSalesCents`, `expectedBoxCents`, `totalSalesCents`, `cash.countedCents`, `cashVarianceCents`, `cashBand`, `depositExpectedCents`, `depositVarianceCents` and `depositBand`. `recon.cash.counts` is `[]`.
- Still present while hidden: the opening count, PayPal units and amounts, `cash.status`, who counted (`cashCounts[].countedBy`), and `recountSkus` with each flagged line's `recountReason`.

## Payments

| Method & path | Body | Success | Rules |
|---|---|---|---|
| `POST /api/orders` | `{ nightId, booth?: /^[a-z0-9-]{1,24}$/ (default "window"), cart: { sku: int 0–20 }, requestId?: /^[A-Za-z0-9_-]{8,64}$/ }` | `201 { id, code, totalCents, simulated }` | 404 if the night is unknown; 409 "The stand is not taking orders right now." unless `selling` (checked again after PayPal answers). The cart needs at least one unit. Items whose opening count is 0 are not on sale: 400 "`<item>` isn't on sale tonight." Unknown SKUs get 400. The server prices the cart from the menu (`buildOrderRequest`) and creates the PayPal order with `PayPal-Request-Id: order-<requestId>`, stored as CREATED with a 3-character pickup `code`. Sending the same `requestId` again returns the stored order with 200. Without PayPal credentials the id is `SIM-…` and `simulated: true`. PayPal error → 502 |
| `GET /api/orders/[id]` | | `200 { status, code, items, totalCents }` | 404 if unknown. Public, so it carries no payer, capture id or night data. The buyer's phone polls it while a payment is pending |
| `POST /api/orders/[id]/capture` | optional; `{ mockDecline?: boolean }` | see below | |
| `POST /api/orders/[id]/refund` | `{ by }` | `200 { status: "REFUNDED", refundId }` | see below |
| `POST /api/paypal/webhook` | PayPal event (raw) | `200 { ok: true, result, detail? }` | see below |

### Capture responses

The body may be empty. Statuses in the order they are checked:

| Status | Body | When |
|---|---|---|
| 404 | `{ error }` | unknown order |
| 200 | `{ status: "COMPLETED", code, items, totalCents }` | already COMPLETED (repeat calls are safe), or captured now. `items` and `totalCents` are PayPal's own, from GET order after the capture |
| 409 | `{ error: "This order was refunded." }` | order is REFUNDED |
| — | | **The night is no longer `selling`.** No new capture is started. For a PayPal order the route first reads the order back, because an earlier try may have gone through with its answer lost: COMPLETED → recorded and 200 as above (with a late-capture notice for the officers); PENDING → 202; refunded → 409; reading it back fails → 502. Otherwise, and always for `SIM-…` orders: |
| 409 | `{ error: "The stand stopped taking orders before this payment went through, so you were not charged.", reason: "STAND_CLOSED" }` | no capture on the order, so no money moved. A capture PayPal finishes on its own later still arrives by webhook and is recorded with a notice |
| 402 | `{ status: "DECLINED", issue, code }` | `INSTRUMENT_DECLINED`, or PayPal reports the capture DECLINED or FAILED. The order is marked DECLINED and `order.declined` is published; the buyer button calls `actions.restart()` |
| 409 | `{ error }` | `ORDER_NOT_APPROVED`, or PayPal reports the capture as refunded before we saw it complete |
| 422 | `{ error }` | PayPal refused the capture for another reason; nothing was charged |
| 502 | `{ error: "PayPal has not confirmed this payment yet. Please don't pay again." }` | no clear answer from the capture call, and reading the order back failed or showed no capture yet. Capturing again is safe: `PayPal-Request-Id: capture-<id>` stops a second charge |
| 202 | `{ status: "PENDING", code }` | PayPal is holding the capture for review. The `PAYMENT.CAPTURE.COMPLETED` webhook finishes it; the phone polls `GET /api/orders/[id]` and doesn't offer the pay buttons again |

After a timeout or `ORDER_ALREADY_CAPTURED`, the route reads the order back from PayPal and uses that answer. `mockDecline` sends `PayPal-Mock-Response: {"mock_application_codes":"INSTRUMENT_DECLINED"}` (sandbox negative testing). Offline demo orders (`SIM-…`) complete without calling PayPal. If PayPal's items or total differ from what was priced, or the capture is recorded after the night stopped selling, a notice is filed for the officers. Publishes `order.paid`.

### Refund rules

- 404 if the order or its game is unknown. 409 for sample games and `SAMPLE-…` orders.
- `by` must be on the roster (400).
- Already REFUNDED → 200 with the stored `refundId`, no second refund. Anything but COMPLETED → 409 "Only a paid order can be refunded."
- Full refund of the capture with `PayPal-Request-Id: refund-<orderId>`. `CAPTURE_FULLY_REFUNDED` (refunded in the PayPal dashboard) is recorded as `refundId: "refunded-in-paypal"`. A refund PayPal reports FAILED or CANCELLED, or any other PayPal error → 502. No capture id → 409. Offline demo orders get `SIMREF-<id>`.
- The units leave the PayPal column straight away. Refunds stay open after the night is closed or deposited; then a notice tells the officers how the expected cash changed. Publishes `order.refunded`.
- Staff only when `STAFF_PIN` is set.

### Webhook

- The raw body is read first (64 KB limit) and parsed. A body that isn't a PayPal event (no string `id` and `event_type`) → 400, before any call to PayPal.
- The signature is checked with `POST /v1/notifications/verify-webhook-signature` using `PAYPAL_WEBHOOK_ID`, with the body spliced in exactly as received. Missing PayPal headers or a cert URL outside `*.paypal.com` fail without calling PayPal.
- **Not verified → 400**, and nothing is stored. This includes a server without `PAYPAL_WEBHOOK_ID` or PayPal credentials. A genuine event that failed is delivered again by PayPal.
- **PayPal couldn't be reached to verify → 503**, nothing stored, so PayPal sends it again later.
- Verified events are stored once per event id. A repeat gets `200 { result: "duplicate" }`.
- **An event that depends on something not recorded yet → 503** (for example a refund for a capture PayPal doesn't show as refunded yet). Any other failure while applying it → 500. In both cases the stored id is removed first, so PayPal's retry is processed instead of skipped.
- Handled: `PAYMENT.CAPTURE.COMPLETED` (records the order from GET order), `PAYMENT.CAPTURE.REFUNDED` (full refunds are recorded; a partial refund files a notice), `PAYMENT.CAPTURE.DENIED` and `PAYMENT.CAPTURE.DECLINED` (mark an unpaid order DECLINED), `PAYMENT.PAYOUTS-ITEM.*` (matched by payout item or batch id, or by `sender_item_id` before the batch id is stored). Anything else → `200 { result: "ignored", detail }`.

## Reimbursements

States: `status` is `requested`, `sent` or `failed`. `payoutStatus` is `null` before a send, `"UNKNOWN"` while PayPal hasn't confirmed the current try, or PayPal's item status (`PENDING`, `UNCLAIMED`, `SUCCESS`, …). `FAILED`, `RETURNED`, `BLOCKED`, `DENIED`, `REFUNDED` and `REVERSED` move the reimbursement to `failed`; `UNCLAIMED` does not. `error` holds the plain explanation shown on the card.

Each try has its own `sender_batch_id`: the reimbursement id, then `<id>-2`, `<id>-3` after a definite failure. `sender_item_id` is always the reimbursement id. PayPal never accepts a `sender_batch_id` twice, which is how a try with no answer is settled without paying twice. Without PayPal credentials the payout is simulated (`SIM-BATCH-…`, status `SUCCESS`).

Approve, retry, and refresh when it sends a try again: 404 if the reimbursement is unknown, 409 on a sample game, and 409 "This payout is already being sent." while another of these requests for the same reimbursement is in progress.

| Method & path | Body | Success | Rules |
|---|---|---|---|
| `POST /api/nights/[id]/reimbursements` | `{ requester, payeeEmail (valid, ≤ 254), cents: int 1–50000, memo: string (1–200), receiptSha256?: 64 hex }` | `201 { id }` | 404 if the night is unknown; 409 on a sample game. `requester` on the roster; 400 if the receipt photo was not uploaded. Above $500.00 → 400 (goes through the treasurer directly). Status `requested` |
| `POST /api/reimbursements/[rid]/approve` | `{ approver }` | `200` or `202 { status, payoutStatus, batchId, error }` | Already has a batch id or `sent` → 200 with the current state, nothing sent. Otherwise `failed` → 409 (use retry), and `payoutStatus: "UNKNOWN"` → 409 (use refresh). The approver must be on the roster (400) with the role officer or treasurer (403), must not be the requester (400), and the opening count must be saved (400). Sends the payout. 200 when PayPal accepted it (`sent`, or `failed` if the item status is a failure). 202 when PayPal didn't answer or already holds this `sender_batch_id` without saying which batch (`requested`, `payoutStatus: "UNKNOWN"`). 502 when PayPal refused it (`failed`). If a try was already on record (the server stopped mid-send), it is sent again under the same `sender_batch_id`, and a refusal other than an invalid request (400 `VALIDATION_ERROR`, `INVALID_REQUEST`, `MALFORMED_REQUEST`) keeps it unconfirmed with 202 instead of marking it failed |
| `POST /api/reimbursements/[rid]/refresh` | | `200 { status, payoutStatus }` | **No batch id:** 409 "This reimbursement has not been sent yet." unless `payoutStatus` is `UNKNOWN`. If it is, the same try is sent again under the same `sender_batch_id`, which either finds PayPal's batch or sends it now: 200 with the result; 503 "PayPal still did not answer…" if there is still no answer; 502 with status `failed` if PayPal refused it as an invalid request, since the first send had the same body; 502 with the explanation if PayPal answered in any other way that doesn't say whether it already holds the payout, which stays `UNKNOWN` so it can't be sent as a new payout. **Simulated batch:** 200 with the stored state. **Otherwise:** GET the payout item (or the batch when the item id is missing) and store its status. 502 if PayPal can't be reached |
| `POST /api/reimbursements/[rid]/retry` | `{ approver, payeeEmail?: valid email }` | `200` or `202 { status, payoutStatus, batchId, error }` | Only for `failed` (409 otherwise, "This payout was already sent." when `sent`). Same approver rules as approve. An optional corrected `payeeEmail` replaces the stored one (audited). Sends a new try with the next `sender_batch_id`. Status codes as for approve |

## CountResult (vision output, validated with zod)

```ts
{
  items: { sku: string; count: number; confidence: "high" | "medium" | "low"; boxes: [number, number, number, number][] }[]; // boxes: [ymin, xmin, ymax, xmax] on a 0–1000 grid
  unknown: { label: string; count: number }[];   // things on the table that are not on the menu
  quality: string[];                              // e.g. "items stacked", "glare", "table edge cut off"
}
```
