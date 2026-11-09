import { notFound } from "next/navigation";
import { getNightState } from "@/lib/repo";
import { ensureSeeded } from "@/lib/seed";
import { formatCents } from "@/lib/money";
import { payoutUnconfirmed } from "@/lib/payout-state";
import { LiveRefresh } from "@/components/LiveRefresh";
import { ReimbursementCard, ReimbursementRequestForm } from "@/components/Reimbursements";
import { Card, PageHeader, Pill } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ReimbursePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  ensureSeeded();
  const state = getNightState(id);
  if (!state) notFound();
  const { night, reimbursements } = state;
  const newestFirst = [...reimbursements].reverse();
  const total = reimbursements.reduce((s, r) => s + r.cents, 0);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title={`Supply reimbursements · ${night.title}`}
        back={{ href: `/nights/${id}`, label: "Game page" }}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>A parent who bought supplies is repaid with PayPal after a second person approves.</span>
            {night.sample && <Pill>Sample data</Pill>}
            {reimbursements.some((r) => r.status === "sent" || payoutUnconfirmed(r)) && <LiveRefresh nightId={id} />}
          </span>
        }
      />

      <Card title="New request">
        <ReimbursementRequestForm nightId={id} people={state.people} />
      </Card>

      <section aria-labelledby="requests-heading" className="space-y-3">
        <div className="flex items-baseline gap-2">
          <h2 id="requests-heading" className="text-base font-semibold text-ink">Requests</h2>
          {reimbursements.length > 0 && (
            <span className="text-sm text-muted">
              {reimbursements.length} · {formatCents(total)}
            </span>
          )}
        </div>
        {newestFirst.length ? (
          newestFirst.map((r) => <ReimbursementCard key={r.id} item={r} people={state.people} openingCountDone={state.open !== null} />)
        ) : (
          <p className="rounded-xl border border-dashed border-line bg-card p-6 text-center text-sm text-muted">
            No requests for this game yet.
          </p>
        )}
      </section>
    </div>
  );
}
