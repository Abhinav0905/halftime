// Registers this app's webhook with the PayPal sandbox app and prints its id.
//
//   npm run webhook:register -- https://halftime.example.com
//
// Put the printed id in PAYPAL_WEBHOOK_ID. Running it again for the same URL
// prints the existing id instead of creating a second webhook.

import fs from "node:fs";
import path from "node:path";
import { paypalConfigured } from "../lib/config";
import { paypalFetch, PayPalError } from "../lib/paypal/client";

const EVENTS = [
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.RETURNED",
  "PAYMENT.PAYOUTS-ITEM.BLOCKED",
];

interface Webhook {
  id: string;
  url: string;
  event_types: { name: string }[];
}

const envFile = path.resolve(__dirname, "..", ".env.local");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

async function main() {
  const host = process.argv[2];
  if (!host || !/^https:\/\//.test(host)) {
    console.error("Usage: npm run webhook:register -- https://your-host\nPayPal only delivers webhooks to public https URLs.");
    process.exit(1);
  }
  if (!paypalConfigured()) {
    console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox) in .env.local first.");
    process.exit(1);
  }
  const url = `${host.replace(/\/+$/, "")}/api/paypal/webhook`;

  const { webhooks } = await paypalFetch<{ webhooks: Webhook[] }>("/v1/notifications/webhooks");
  const found = webhooks.find((w) => w.url === url);
  if (found) {
    const missing = EVENTS.filter((e) => !found.event_types.some((t) => t.name === e || t.name === "*"));
    console.log(`A webhook for ${url} already exists.`);
    if (missing.length) console.log(`It is not subscribed to: ${missing.join(", ")}. Update it in the developer dashboard.`);
    console.log(`PAYPAL_WEBHOOK_ID=${found.id}`);
    return;
  }

  const created = await paypalFetch<Webhook>("/v1/notifications/webhooks", {
    body: { url, event_types: EVENTS.map((name) => ({ name })) },
  });
  console.log(`Registered ${url} for ${EVENTS.length} event types.`);
  console.log(`PAYPAL_WEBHOOK_ID=${created.id}`);
}

main().catch((err) => {
  if (err instanceof PayPalError) {
    console.error(`PayPal returned ${err.status} ${err.name}${err.issue ? ` (${err.issue})` : ""}: ${err.message}`);
    if (err.debugId) console.error(`debug_id ${err.debugId}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
