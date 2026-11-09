import { notFound } from "next/navigation";
import { Callout, LinkButton, PageHeader } from "@/components/ui";
import { paypalUnitsBySku } from "@/lib/engine/reconcile";
import { getCounts, getNight, listItems, listOrders, listPeople } from "@/lib/repo";
import { CountFlow, type FloorMap } from "./CountFlow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COPY = {
  open: {
    title: "Opening count",
    why: "Everything sold tonight is measured from this count, so photograph the table before the first sale.",
  },
  close: {
    title: "Closing count",
    why: "Photograph what is left. Anything dropped, expired or given away goes in as waste so it is not counted as a sale.",
  },
} as const;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
}

export default async function CountPage({ params }: { params: Promise<{ id: string; kind: string }> }) {
  const { id, kind } = await params;
  if (kind !== "open" && kind !== "close") notFound();
  const night = getNight(id);
  if (!night) notFound();

  const copy = COPY[kind];
  const back = { href: `/nights/${id}`, label: night.title };
  const header = <PageHeader title={copy.title} subtitle={`${night.title} · ${night.date}`} back={back} />;

  const orders = listOrders(id);
  const counts = getCounts(id);

  let blocked: { title: string; body: string; action?: { href: string; label: string } } | null = null;
  if (kind === "open") {
    const salesStarted = orders.some((o) => o.status === "COMPLETED" || o.status === "REFUNDED");
    if (salesStarted || !(night.status === "setup" || night.status === "selling")) {
      blocked = { title: "Sales have started, so the opening count is locked.", body: "The opening count can only change before the first PayPal sale." };
    }
  } else if (night.status === "setup") {
    blocked = {
      title: "Save the opening count first.",
      body: "The closing count is compared with the opening count, so that one comes first.",
      action: { href: `/nights/${id}/count/open`, label: "Opening count" },
    };
  } else if (night.status === "closed" || night.status === "deposited") {
    blocked = { title: "This game is finalized, so the closing count is locked.", body: "Ask an officer if a count needs to be corrected." };
  }

  if (blocked) {
    return (
      <div className="mx-auto max-w-xl">
        {header}
        <Callout tone="warn" title={blocked.title}>{blocked.body}</Callout>
        <div className="mt-4 flex gap-2">
          {blocked.action && <LinkButton href={blocked.action.href} size="lg">{blocked.action.label}</LinkButton>}
          <LinkButton href={back.href} variant="secondary" size="lg">Back to the game</LinkButton>
        </div>
      </div>
    );
  }

  const items = listItems().map((i) => ({ sku: i.sku, name: i.name }));
  const existing = counts[kind];

  // During the closing count PayPal's itemized sales cap how many units can be left.
  let floor: FloorMap | null = null;
  if (kind === "close" && counts.open) {
    const paypal = paypalUnitsBySku(orders.map((o) => ({ status: o.status, items: o.items, totalCents: o.totalCents })));
    floor = Object.fromEntries(items.map((i) => [i.sku, { open: counts.open?.counts[i.sku] ?? 0, paypalUnits: paypal[i.sku] ?? 0 }]));
  }

  return (
    <div>
      {header}
      <p className="-mt-3 mb-5 max-w-2xl text-base text-ink-soft">{copy.why}</p>
      {existing && (
        <div className="mb-5 max-w-2xl">
          <Callout tone="neutral" title="This count was already saved.">
            Counted by {existing.countedBy}, checked by {existing.checkedBy}, {formatTime(existing.createdAt)}. Saving again replaces it, and the change is kept in the history.
          </Callout>
        </div>
      )}
      <CountFlow
        nightId={id}
        kind={kind}
        items={items}
        people={listPeople()}
        floor={floor}
        initialCounts={existing?.counts ?? null}
        initialWaste={existing?.waste ?? null}
      />
    </div>
  );
}
