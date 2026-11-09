import { subscribe } from "@/lib/events";
import { fail } from "@/lib/http";
import { getNight } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Proxies and load balancers drop idle connections; a comment line every 15 s keeps this one open.
const HEARTBEAT_MS = 15_000;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!getNight(id)) return fail("That game was not found.", 404);

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const unsubscribe = subscribe(id, (event) => send(`data: ${JSON.stringify(event)}\n\n`));
      const ping = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        unsubscribe();
        req.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      req.signal.addEventListener("abort", cleanup);
      if (req.signal.aborted) cleanup();
      // Tell EventSource how soon to reconnect, and flush the headers right away.
      send("retry: 3000\n\n");
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
