import { notFound } from "next/navigation";
import { LocalTime } from "@/components/LocalTime";
import { formatGameDate } from "@/components/format";
import { Callout, LinkButton, PageHeader } from "@/components/ui";
import { paypalUnitsBySku } from "@/lib/engine/reconcile";
import { getCounts, getNight, listCashCounts, listItems, listOrders, listPeople } from "@/lib/repo";
import { demoPhotoUrl } from "@/lib/vision/demo";
import type { LeftoverCaps } from "@/components/count/CountEditor";
import { CountFlow } from "./CountFlow";

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

export default async function CountPage({ params }: { params: Promise<{ id: string; kind: string }> }) {
  const { id, kind } = await params;
  if (kind !== "open" && kind !== "close") notFound();
  const night = getNight(id);
  if (!night) notFound();

  const copy = COPY[kind];
  const back = { href: `/nights/${id}`, label: night.title };
  const header = <PageHeader title={copy.title} subtitle={`${night.title} · ${formatGameDate(night.date, { year: true })}`} back={back} />;

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
  } else if (listCashCounts(id).length > 0) {
    blocked = {
      title: "Counts are locked because cash counting has started.",
      body: "If something was off, add a note about it when you finalize the night.",
      action: { href: `/nights/${id}/close`, label: "Back to the close-out" },
    };
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
  // The counts route moves a selling night to closing when this is saved, and the fan menu stops taking orders.
  const closesMenu = kind === "close" && night.status === "selling";

  // One number per item PayPal sold goes to the browser: opening count minus PayPal units, the most that can be
  // left. That is all the "PayPal checks the count" warning needs, and nothing is shown until an entry is over it.
  // The closing counter can still infer limits from it. That is accepted because those two may not count the cash
  // (checkCashCounterNotCloser), so the cash count stays blind. Saved leftovers aren't sent back for a recount.
  let caps: LeftoverCaps | null = null;
  if (kind === "close" && counts.open) {
    const open = counts.open.counts;
    const paypal = paypalUnitsBySku(orders.map((o) => ({ status: o.status, items: o.items, totalCents: o.totalCents })));
    caps = Object.fromEntries(items.filter((i) => (paypal[i.sku] ?? 0) > 0).map((i) => [i.sku, (open[i.sku] ?? 0) - (paypal[i.sku] ?? 0)]));
  }

  return (
    <div>
      {header}
      <p className="-mt-3 mb-5 max-w-2xl text-base text-ink-soft">
        {copy.why}
        {closesMenu && " Do this once the stand is done selling: saving it closes the fan menu."}
      </p>
      {existing && (
        <div className="mb-5 max-w-2xl">
          <Callout tone="neutral" title="This count was already saved.">
            Counted by {existing.countedBy}, checked by {existing.checkedBy}, <LocalTime iso={existing.createdAt} />.
            {kind === "close" && " A recount starts from zero, so count every item on the table again. Waste entries are kept."} Saving
            again replaces it, and the change is kept in the history.
          </Callout>
        </div>
      )}
      <CountFlow
        nightId={id}
        kind={kind}
        items={items}
        people={listPeople()}
        caps={caps}
        initialCounts={kind === "open" ? existing?.counts ?? null : null}
        initialWaste={existing?.waste ?? null}
        demoPhoto={demoPhotoUrl(kind)}
        closesMenu={closesMenu}
      />
    </div>
  );
}
