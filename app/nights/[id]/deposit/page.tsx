import { notFound } from "next/navigation";
import { getNightState } from "@/lib/repo";
import { ensureSeeded } from "@/lib/seed";
import { formatCents } from "@/lib/money";
import { BandResult } from "@/components/BandResult";
import { DepositForm } from "@/components/DepositForm";
import { LocalTime } from "@/components/LocalTime";
import { Callout, Card, LinkButton, NightStatusPill, PageHeader, Pill } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function DepositPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  ensureSeeded();
  const state = getNightState(id);
  if (!state) notFound();
  const { night, recon, club, deposit } = state;
  const base = `/nights/${id}`;
  const counters = [...new Set(state.cashCounts.map((c) => c.countedBy))];

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        title={`Deposit · ${night.title}`}
        back={{ href: base, label: "Game page" }}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <NightStatusPill status={night.status} />
            {night.sample && <Pill>Sample data</Pill>}
          </span>
        }
      />

      {night.status === "deposited" && deposit ? (
        <>
          {recon.depositExpectedCents !== null && recon.depositVarianceCents !== null && recon.depositBand ? (
            <BandResult
              kind="deposit"
              expectedLabel="Should be deposited"
              actualLabel="Deposited"
              expectedCents={recon.depositExpectedCents}
              actualCents={deposit.cents}
              varianceCents={recon.depositVarianceCents}
              band={recon.depositBand}
              toleranceCents={club.toleranceCents}
            />
          ) : (
            <Card>
              <p className="text-ink">Deposited: <strong className="tabular">{formatCents(deposit.cents)}</strong></p>
            </Card>
          )}
          <Card title="Details">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted">Deposited by</dt>
              <dd className="text-ink">{deposit.depositor}</dd>
              <dt className="text-muted">Recorded</dt>
              <dd className="text-ink"><LocalTime iso={deposit.createdAt} /></dd>
              {recon.cash.countedCents !== null && (
                <>
                  <dt className="text-muted">Cash counted</dt>
                  <dd className="text-ink tabular">{formatCents(recon.cash.countedCents)} by {counters.join(" and ")}</dd>
                </>
              )}
              <dt className="text-muted">Float kept back</dt>
              <dd className="text-ink tabular">{formatCents(night.floatCents)}</dd>
            </dl>
            {deposit.slipSha256 && (
              <img
                src={`/api/photos/${deposit.slipSha256}`}
                alt="Photo of the bank deposit slip"
                className="mt-4 max-h-80 rounded-lg border border-line object-contain"
              />
            )}
          </Card>
          <p className="text-sm text-ink-soft">
            {recon.depositBand && recon.depositBand !== "green"
              ? "What happens next: an officer compares the bank slip with the count sheet and follows up with the volunteers. Nothing else is needed here."
              : "This game is complete."}
          </p>
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/ledger" variant="secondary">Season ledger</LinkButton>
            <LinkButton href="/" variant="secondary">Home</LinkButton>
          </div>
        </>
      ) : night.status === "closed" ? (
        <Card>
          <p className="mb-4 text-sm text-ink-soft">
            Take the cash, minus the {formatCents(night.floatCents)} float, to the bank. Then enter the amount printed on the deposit slip.
            If it differs from the counted cash, the officers get a notice.
          </p>
          <DepositForm nightId={id} people={state.people} cashCounters={counters} />
        </Card>
      ) : (
        <Callout tone="info" title="Finish the close-out first">
          <p>The deposit is recorded after the cash box is counted twice and the night is finalized.</p>
          <div className="mt-3">
            <LinkButton href={`${base}/close`} variant="secondary">Go to the close-out</LinkButton>
          </div>
        </Callout>
      )}
    </div>
  );
}
