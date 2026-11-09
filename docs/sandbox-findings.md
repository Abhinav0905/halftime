# PayPal sandbox findings

Run on 2026-11-08 (US Pacific evening; PayPal timestamps below are UTC, 2026-11-09) against `api-m.sandbox.paypal.com` with the project's sandbox REST app.

## How it was run

Next.js 16 allows one `next dev` per project folder (it locks `.next/dev`), and another server already held it, so the route handlers were called directly from a `tsx` script against `./data/a.db`. The calls went through the real handler code, the PayPal Server SDK and the sandbox. Separately, read-only and validation-only requests through the running dev server confirmed that the routes compile and respond under Next (404s, a 400 for an empty cart, the SSE headers and the first `retry:` frame).

## What was checked

| Step | Result | IDs |
|---|---|---|
| `POST /api/nights` | 201 | `night_IyaiwjnE` |
| `POST /api/orders` before the night was selling | 409 "The stand is not taking orders right now." | |
| `POST /api/orders` `{ hotdog: 2, water: 1 }` | 201, real order, $7.00, pickup code `V9Y`, 1357 ms (includes the first OAuth token fetch) | order `5SN78122C07855234` |
| Same request again with the same `requestId` (double tap) | 200, same order id and code, 1027 ms. One row in the database. | |
| `POST /api/orders` with an unknown SKU | 400 "Unknown item: lobster" | |
| `GET /v2/checkout/orders/{id}` | `status CREATED`, `reference_id night_IyaiwjnE`, `custom_id night_IyaiwjnE:window`, `invoice_id night_IyaiwjnE-V9Y`, `soft_descriptor BOOSTERS`, `item_total` 7.00 = `amount` 7.00, items `water ×1 @1.00` and `hotdog ×2 @3.00` with `sku` and `category PHYSICAL_GOODS`. 367 ms. The SDK's `getOrder` maps it to the same lines and 700 cents (913 ms). | |
| Capture before the buyer approved | PayPal 422 `ORDER_NOT_APPROVED`, route 409 "The buyer has not approved this payment yet." 428 ms | |
| Capture with `mockDecline: true` | PayPal 422 `UNPROCESSABLE_ENTITY` / `INSTRUMENT_DECLINED`, route 402 `{ status: "DECLINED", issue: "INSTRUMENT_DECLINED", code: "V9Y" }`, row marked DECLINED, `order.declined` published. 235 ms | |
| SSE `GET /api/nights/{id}/events` | `text/event-stream`, first frame `retry: 3000`, published event arrives as `data: {"type":"cash.counted"}`; one listener before abort, zero after | |
| Reimbursement request, approval by the requester | 400 "Someone other than the requester has to approve." | `reimb_6wJWDSUG` |
| Approval by Pat Okafor: **one real payout, $1.00 to halftime-test-payee@example.com** | 200 `{ status: "sent", payoutStatus: "PENDING", batchId }`, 1358 ms (POST plus one GET of the batch). The item id was already available on that first GET. | batch `KXUZXA8JJW8G8`, item `MEEXVK2YXWBRE`, transaction `3F248672KC169315W` |
| Approval again by Sam Ortiz | 200, same batch, no second payout sent | |
| Refresh at about +3 s and +11 s | `PENDING` | |
| Refresh at about +28 s | `UNCLAIMED` (expected: the address has no PayPal account) | |
| Close-out on the same night (close count, two blind cash counts $27.00 short, finalize, deposit $5.00 under) | finalize 200, red notice "Cash box is $27.00 short of expected"; deposit 200, amber notice "Deposit is $5.00 lower than the counted cash". The DECLINED order did not count toward PayPal units. | |
| `POST /api/paypal/webhook` without `PAYPAL_WEBHOOK_ID` | 200 `{ result: "unverified" }`, event stored, nothing applied | |
| Offline demo mode (credentials removed) | `SIM-…` order, capture with an empty body → COMPLETED, repeat capture returns the same, refund → `SIMREF-…`; refunding a sample order from a deposited night files "PayPal order S05 was refunded after close-out" | |

Payout timeline from `GET /v1/payments/payouts/KXUZXA8JJW8G8`: batch created 06:35:57Z, item processed 06:36:12Z, batch `SUCCESS` at 06:36:20Z. The item reads `UNCLAIMED` with `errors.name = RECEIVER_UNREGISTERED`. `sender_batch_id` and `sender_item_id` are both `reimb_6wJWDSUG`. Fee: $0.25.

## Sandbox behaviour worth knowing

1. **A reused `PayPal-Request-Id` returns the original order even when the body differs.** The double-tapped request carried a new pickup code and therefore a new `invoice_id`, but PayPal still answered with order `5SN78122C07855234`. `POST /api/orders` handles this by returning the row it already stored.
2. **Failed captures are not replayed under the same request id.** On a separate test order (`49M69636M87335320`), a mocked `INSTRUMENT_DECLINED` capture with key `capture-<id>` was followed by a plain capture with the same key, and PayPal answered `ORDER_NOT_APPROVED` instead of repeating the decline. So after a decline, the buyer can pay again with the same key.
3. **`PayPal-Mock-Response` works on an unapproved order.** No buyer login is needed to show the decline path on camera. The mock header also works on order creation (`DUPLICATE_INVOICE_ID` came back as 422).
4. **Batch status and item status differ.** The batch reached `SUCCESS` while its only item was `UNCLAIMED`. The app stores and shows the item status. An UNCLAIMED item also carries an `errors` object. That does not mean the payout failed; only FAILED, RETURNED, BLOCKED, DENIED, REFUNDED and REVERSED are treated as failed.
5. **The payout create response never includes the item id.** A GET of the batch straight after the POST already listed the item in this run. `sendPayout` retries that GET once after 1.5 s, and the refresh route fills in the item id later if it is still missing.
6. **Timings:** OAuth token 416 ms; create order about 1.0–1.4 s; GET order 0.4–0.9 s; capture errors 0.2–0.6 s; an UNCLAIMED result about 15–28 s after the payout POST.
7. **Webhooks:** the sandbox app has no webhooks registered yet (`GET /v1/notifications/webhooks` returned an empty list). Verifying a forged signature returned `verification_status: FAILURE` in 267 ms, not an HTTP error. Real delivery still needs a public https URL. Run `npm run webhook:register -- https://<host>` after deploying and set `PAYPAL_WEBHOOK_ID`. Until then every event is stored as unverified and ignored.
8. **SDK token handling:** the APIMatic OAuth adapter keeps a rejected token promise for the life of the client, so one network failure while fetching a token would break every later call. `lib/paypal/client.ts` builds a fresh SDK client after any failure that is not an HTTP error. This came from reading the code; it was not seen in the sandbox.
9. On this machine Node reaches the sandbox through the corporate CA bundle in `NODE_EXTRA_CA_CERTS` (already set in the shell profile). A hosted deployment does not need it.

## Not yet checked

- An approved capture. This needs a sandbox buyer to log in through the browser button. After it, check that `funding` reads `paypal` or `venmo` from `payment_source`, that `payer` is the buyer's sandbox email, and that the stored items match the GET order.
- A refund of a real capture (`POST /api/orders/{id}/refund`) and the `PAYMENT.CAPTURE.REFUNDED` webhook that follows.
- Live webhook delivery and signature verification, and the lag between capture and `PAYMENT.CAPTURE.COMPLETED`.
