import { notFound } from "next/navigation";
import { getNightState } from "@/lib/repo";
import { ensureSeeded } from "@/lib/seed";
import { formatCents } from "@/lib/money";
import { BandResult } from "@/components/BandResult";
import { CashCountForm, FinalizeForm } from "@/components/CloseOutForms";
import { LiveRefresh } from "@/components/LiveRefresh";
import { LocalTime } from "@/components/LocalTime";
import { ReconTable } from "@/components/ReconTable";
import { Callout, Card, LinkButton, NightStatusPill, PageHeader, Pill, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ClosePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  ensureSeeded();
  const state = getNightState(id);
  if (!state) notFound();
  const { night, recon, club } = state;
  const base = `/nights/${id}`;
  const finished = night.status === "closed" || night.status === "deposited";
  const revealed = recon.cash.status === "agree" || finished;
  const recountLines = recon.lines.filter((l) => l.recount);
  const lastCounter = state.cashCounts.at(-1)?.countedBy ?? null;
  const counters = [...new Set(state.cashCounts.map((c) => c.countedBy))];

  const header = (
    <PageHeader
      title={`Close-out · ${night.title}`}
      back={{ href: base, label: "Game page" }}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <NightStatusPill status={night.status} />
          {night.sample && <Pill>Sample data</Pill>}
          {/* Picks up the second cash count when it is entered on another phone. */}
          {(night.status === "selling" || night.status === "closing") && <LiveRefresh nightId={id} />}
        </span>
      }
    />
  );

  if (!state.close) {
    return (
      <div className="space-y-5">
        {header}
        <Card>
          <h2 className="text-lg font-semibold text-ink">{state.open ? "Count the leftovers first" : "Start with the opening count"}</h2>
          <p className="mt-1 text-ink-soft">
            {state.open
              ? "When the game ends, photograph what is left on the table. A second volunteer checks the count, then the cash box is counted here."
              : "The close-out compares the stock at the start of the game with what is left at the end, so it needs the opening count first."}
          </p>
          <div className="mt-4">
            {state.open ? (
              <LinkButton href={`${base}/count/close`} size="lg">Count leftovers</LinkButton>
            ) : (
              <LinkButton href={`${base}/count/open`} size="lg">Count opening stock</LinkButton>
            )}
          </div>
          {state.open && (
            <p className="mt-4 text-sm text-muted">
              So far: {recon.paypalOrders} PayPal {recon.paypalOrders === 1 ? "order" : "orders"}, {formatCents(recon.paypalCents)}.
            </p>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {header}

      <Card
        title="Item by item"
        aside={
          <span className="text-xs text-muted">
            Leftovers counted by {state.close.countedBy}, checked by {state.close.checkedBy}
          </span>
        }
      >
        <p className="mb-3 text-sm text-ink-soft">
          Sold = opening − closing − waste. PayPal recorded exactly which items were paid digitally, so the rest must have been paid in cash.
        </p>
        <ReconTable lines={recon.lines} revealCash={revealed} />
        {!revealed && (
          <p className="mt-3 text-xs text-muted">Cash columns appear after both cash counts are in, so neither counter sees the expected amount first.</p>
        )}
      </Card>

      {recountLines.length > 0 && (
        <Callout tone="warn" title={`${recountLines.length} ${recountLines.length === 1 ? "item needs" : "items need"} a recount`}>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {recountLines.map((l) => (
              <li key={l.sku}>
                <strong>{l.name}:</strong> {l.recountReason}
              </li>
            ))}
          </ul>
          <p className="mt-2">
            PayPal&apos;s record of each paid item is exact, so a photo count that shows fewer sold than PayPal must be off. Count those items on the
            table again. The expected cash can&apos;t be worked out until they are fixed.
          </p>
          {night.status === "closing" && (
            <div className="mt-3">
              <LinkButton href={`${base}/count/close`} variant="secondary">Recount leftovers</LinkButton>
            </div>
          )}
        </Callout>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="PayPal sales" value={formatCents(recon.paypalCents)} hint={`${recon.paypalOrders} orders`} />
        <Stat
          label="Expected cash sales"
          value={revealed ? (recon.expectedCashSalesCents === null ? "—" : formatCents(recon.expectedCashSalesCents)) : "Hidden"}
          hint={revealed ? undefined : "until both counts are in"}
        />
        <Stat label="Opening float" value={formatCents(night.floatCents)} />
        <Stat
          label="Expected in box"
          value={revealed ? (recon.expectedBoxCents === null ? "—" : formatCents(recon.expectedBoxCents)) : "Hidden"}
          hint={revealed ? "cash sales + float" : "until both counts are in"}
        />
      </div>

      <Card title="Cash box count">
        {recon.cash.status === "agree" || finished ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-soft">
              Counted separately by {counters.join(" and ")}
              {recon.cash.countedCents !== null && (
                <>
                  : <strong className="tabular text-ink">{formatCents(recon.cash.countedCents)}</strong>
                </>
              )}
              .
            </p>
            {state.cashCounts.length > 2 && (
              <ul className="text-xs text-muted">
                {state.cashCounts.map((c) => (
                  <li key={c.id}>
                    <LocalTime iso={c.createdAt} style="time" /> · {c.countedBy}: <span className="tabular">{formatCents(c.cents)}</span>
                  </li>
                ))}
              </ul>
            )}
            {recon.expectedBoxCents !== null && recon.cash.countedCents !== null && recon.cashVarianceCents !== null && recon.cashBand ? (
              <BandResult
                kind="cash"
                expectedLabel="Expected in box"
                actualLabel="Counted"
                expectedCents={recon.expectedBoxCents}
                actualCents={recon.cash.countedCents}
                varianceCents={recon.cashVarianceCents}
                band={recon.cashBand}
                toleranceCents={club.toleranceCents}
                finalized={finished}
              />
            ) : (
              <Callout tone="warn">
                The counted cash can&apos;t be compared yet because some items still need a recount.
              </Callout>
            )}
          </div>
        ) : night.status === "closing" ? (
          <div className="space-y-4">
            <ol className="space-y-1 text-sm text-ink-soft">
              <li>1. One volunteer counts every bill and coin in the box and enters the total.</li>
              <li>2. A second volunteer counts again without looking at the first number.</li>
              <li>3. When the two totals match, the expected amount is shown.</li>
            </ol>
            <p className="text-sm font-medium text-ink">
              {recon.cash.status === "missing"
                ? "No counts yet."
                : recon.cash.status === "single"
                  ? `1 count in, by ${lastCounter}.`
                  : `${state.cashCounts.length} counts in. The last two are different.`}
            </p>
            <CashCountForm nightId={id} people={state.people} status={recon.cash.status} lastCounter={lastCounter} />
          </div>
        ) : null}
      </Card>

      {night.status === "closing" && recon.cash.status === "agree" && (
        <Card title="Finalize the night">
          <p className="mb-4 text-sm text-ink-soft">
            This locks tonight&apos;s numbers. {recon.cashBand && recon.cashBand !== "green" ? "The officers will get a notice about the difference. " : ""}
            Next, someone who did not count the cash records the bank deposit.
          </p>
          <FinalizeForm nightId={id} people={state.people} noteRequired={recountLines.length > 0} />
        </Card>
      )}

      {finished && (
        <Card>
          <p className="text-ink">
            Finalized{night.closedAt && (
              <>
                {" "}at <LocalTime iso={night.closedAt} />
              </>
            )}
            .
          </p>
          {night.closeNote && <p className="mt-2 text-sm text-ink-soft">Note: {night.closeNote}</p>}
          <div className="mt-3">
            {night.status === "closed" ? (
              <LinkButton href={`${base}/deposit`} size="lg">Next: record the deposit</LinkButton>
            ) : (
              <LinkButton href={`${base}/deposit`} variant="secondary">View the deposit</LinkButton>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
