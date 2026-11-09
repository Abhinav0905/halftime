import { HttpError, handle, ok, readBody } from "@/lib/http";
import { NotReadyYet, VerificationUnavailable, processWebhook } from "@/lib/paypal/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PayPal events are a few KB.
const MAX_EVENT_BYTES = 64 * 1024;

export const POST = handle(async (req: Request) => {
  // The signature covers the exact bytes PayPal sent, so read the raw text before parsing anything.
  const raw = new TextDecoder().decode(await readBody(req, MAX_EVENT_BYTES, "That is too large to be a PayPal webhook event."));
  try {
    const outcome = await processWebhook(req.headers, raw);
    // Not stored. A genuine event that failed to verify is sent again by PayPal.
    if (outcome.result === "unverified") throw new HttpError(400, "The PayPal signature on this event did not verify.");
    return ok({ ok: true, ...outcome });
  } catch (err) {
    if (err instanceof SyntaxError) throw new HttpError(400, "Expected a PayPal webhook event.");
    // 503 makes PayPal deliver the event again later instead of counting it as handled.
    if (err instanceof VerificationUnavailable) throw new HttpError(503, "Could not reach PayPal to check the signature. Please send the event again later.");
    if (err instanceof NotReadyYet) throw new HttpError(503, `Not ready for this event yet: ${err.message}`);
    throw err;
  }
});
