import { HttpError, handle, ok } from "@/lib/http";
import { processWebhook } from "@/lib/paypal/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request) => {
  // The signature covers the exact bytes PayPal sent, so read the raw text before parsing anything.
  const raw = await req.text();
  try {
    const outcome = await processWebhook(req.headers, raw);
    return ok({ ok: true, ...outcome });
  } catch (err) {
    if (err instanceof SyntaxError) throw new HttpError(400, "Expected a PayPal webhook event.");
    throw err;
  }
});
