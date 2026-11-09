import Link from "next/link";
import { getClub, getLedger, getNightState, type LedgerRow } from "@/lib/repo";
import { ensureSeeded } from "@/lib/seed";
import { formatCents } from "@/lib/money";
import { ActionButton } from "@/components/ActionButton";
import { formatGameDate } from "@/components/format";
import { nextStep } from "@/components/nextStep";
import { Card, LinkButton, NightStatusPill, Pill, Variance } from "@/components/ui";

export const dynamic = "force-dynamic";

export default function Home() {
  ensureSeeded();
  const club = getClub();
  const ledger = getLedger();
  const current = ledger.find((r) => r.status !== "deposited");
  const state = current ? getNightState(current.nightId) : null;
  const recent = ledger.filter((r) => r.nightId !== current?.nightId).slice(0, 8);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-muted">{club.name}</p>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Concession stand close-out</h1>
      </div>

      {state ? (
        <TonightCard
          id={state.night.id}
          title={state.night.title}
          date={state.night.date}
          status={state.night.status}
          sample={state.night.sample}
          paypalOrders={state.recon.paypalOrders}
          paypalCents={state.recon.paypalCents}
          step={nextStep({
            id: state.night.id,
            status: state.night.status,
            cashStatus: state.recon.cash.status,
            recount: state.recon.recountSkus.length > 0,
          })}
        />
      ) : (
        <Card className="border-brand/30">
          <h2 className="text-lg font-semibold text-ink">No game in progress</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Start a game when the volunteers arrive. You will photograph the stocked table first, then open the booth QR code for fans.
          </p>
          <div className="mt-4">
            <LinkButton href="/nights/new" size="lg">Start tonight&apos;s game</LinkButton>
          </div>
        </Card>
      )}

      <Card title="Recent games" aside={<Link href="/ledger" className="text-sm font-medium text-brand hover:underline">Season ledger</Link>}>
        {recent.length ? (
          <ul className="-mx-1 divide-y divide-line">
            {recent.map((r) => (
              <RecentRow key={r.nightId} row={r} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Finished games show up here with their cash and deposit differences.</p>
        )}
      </Card>

      <section className="rounded-xl bg-brand-soft p-4 text-sm text-ink-soft sm:p-5">
        <h2 className="font-semibold text-ink">What Halftime does</h2>
        <p className="mt-1">
          Volunteers photograph the snack table before and after the game, and fans pay by PayPal or Venmo at a QR code. Because PayPal
          records exactly which items were paid digitally, Halftime can work out how much cash should be in the box, and tells the
          officers when the count or the deposit is different.
        </p>
        <Link href="/how-it-works" className="mt-2 inline-block font-medium text-brand hover:underline">How the math works</Link>
      </section>

      <div className="border-t border-line pt-4">
        <ActionButton
          url="/api/demo/reset"
          label="Reset demo data"
          pendingLabel="Resetting…"
          confirm="Reset the demo? This deletes every game you created and restores the three sample games."
          redirectTo="/"
        />
        <p className="mt-1 text-xs text-muted">Restores the sample season. Use it before a demo.</p>
      </div>
    </div>
  );
}

function TonightCard(props: {
  id: string;
  title: string;
  date: string;
  status: LedgerRow["status"];
  sample: boolean;
  paypalOrders: number;
  paypalCents: number;
  step: ReturnType<typeof nextStep>;
}) {
  const { id, title, date, status, sample, paypalOrders, paypalCents, step } = props;
  return (
    <Card className="border-brand/40 ring-1 ring-brand/20">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Tonight</span>
        <NightStatusPill status={status} />
        {sample && <Pill>Sample data</Pill>}
      </div>
      <h2 className="mt-2 text-2xl font-bold text-ink">{title}</h2>
      <p className="text-sm text-muted">{formatGameDate(date, { year: true })}</p>
      {status !== "setup" && (
        <p className="mt-3 text-sm text-ink-soft">
          <span className="text-lg font-bold tabular text-ink">{formatCents(paypalCents)}</span> in PayPal sales from{" "}
          {paypalOrders} {paypalOrders === 1 ? "order" : "orders"}
        </p>
      )}
      <p className="mt-3 text-base text-ink">{step.text}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {step.action && <LinkButton href={step.action.href} size="lg">{step.action.label}</LinkButton>}
        <LinkButton href={`/nights/${id}`} variant="secondary" size="lg">Game page</LinkButton>
      </div>
    </Card>
  );
}

function RecentRow({ row }: { row: LedgerRow }) {
  return (
    <li>
      <Link href={`/nights/${row.nightId}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-1 py-3 hover:bg-paper">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">{row.title}</span>
            {row.sample && <Pill>Sample</Pill>}
          </div>
          <div className="text-xs text-muted">
            {formatGameDate(row.date)}
            {row.totalSalesCents !== null && <> · {formatCents(row.totalSalesCents)} total sales</>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <NightStatusPill status={row.status} />
          {row.cashVarianceCents !== null && (
            <span className="inline-flex items-center gap-1">
              <span className="text-muted">Cash</span>
              <Variance cents={row.cashVarianceCents} band={row.cashBand} />
            </span>
          )}
          {row.depositVarianceCents !== null && (
            <span className="inline-flex items-center gap-1">
              <span className="text-muted">Deposit</span>
              <Variance cents={row.depositVarianceCents} band={row.depositBand} />
            </span>
          )}
        </div>
      </Link>
    </li>
  );
}
