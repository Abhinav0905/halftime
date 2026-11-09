import Link from "next/link";
import { notFound } from "next/navigation";
import { getNightState, listAudit, type NightState } from "@/lib/repo";
import { ensureSeeded } from "@/lib/seed";
import { formatCents } from "@/lib/money";
import { payoutInFlight, payoutUnconfirmed } from "@/lib/payout-state";
import { AuditTrail } from "@/components/AuditTrail";
import { LiveRefresh } from "@/components/LiveRefresh";
import { LocalTime } from "@/components/LocalTime";
import { NightProgress } from "@/components/NightProgress";
import { OrderList } from "@/components/OrderList";
import { QrCode } from "@/components/QrCode";
import { formatGameDate } from "@/components/format";
import { nextStep } from "@/components/nextStep";
import { isLocalOnlyUrl, requestBaseUrl } from "@/components/requestBaseUrl";
import { Callout, Card, LinkButton, NightStatusPill, PageHeader, Pill, Stat, Variance, bandTone } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function NightPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  ensureSeeded();
  const state = getNightState(id);
  if (!state) notFound();
  const { night, recon } = state;
  const step = nextStep({ id, status: night.status, cashStatus: recon.cash.status, recount: recon.recountSkus.length > 0 });
  const selling = night.status === "selling";
  const menuUrl = `${await requestBaseUrl()}/m/${encodeURIComponent(id)}`;
  const live = night.status === "selling" || night.status === "closing";
  // A payout PayPal is still working on updates this page when its webhook arrives.
  const watch = live || state.reimbursements.some(payoutInFlight);

  return (
    <div className="space-y-5">
      <PageHeader
        title={night.title}
        back={{ href: "/", label: "Home" }}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>{formatGameDate(night.date, { year: true })}</span>
            <NightStatusPill status={night.status} />
            {night.sample && <Pill>Sample data</Pill>}
            {watch && <LiveRefresh nightId={id} />}
          </span>
        }
      />

      {night.sample && (
        <Callout tone="neutral">
          A sample game from earlier in the season. Its orders were recorded for the demo rather than taken through PayPal.
        </Callout>
      )}

      <NightProgress state={state} />

      <Card className="border-brand/30">
        <p className="text-base text-ink">{step.text}</p>
        {(step.action || step.secondary) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {step.action && <LinkButton href={step.action.href} size="lg">{step.action.label}</LinkButton>}
            {step.secondary && <LinkButton href={step.secondary.href} variant="secondary" size="lg">{step.secondary.label}</LinkButton>}
          </div>
        )}
      </Card>

      {selling && (
        <div className="grid items-start gap-5 md:grid-cols-[minmax(0,18rem)_1fr]">
          <Card title="Booth QR code">
            <div className="mx-auto max-w-64 rounded-lg border border-line bg-white p-3">
              <QrCode value={menuUrl} label={`QR code that opens the menu at ${menuUrl}`} />
            </div>
            <p className="mt-3 text-center text-sm text-ink-soft">Fans scan this to order and pay with PayPal or Venmo.</p>
            <p className="mt-1 break-all text-center font-mono text-xs text-muted">{menuUrl}</p>
            {isLocalOnlyUrl(menuUrl) && (
              <div className="mt-3">
                <Callout tone="warn" title="Phones can't open this address">
                  It points at this computer itself. Open this page using the computer&apos;s Wi-Fi address (for example
                  http://192.168.1.20:3000), or set PUBLIC_BASE_URL to that address in .env.local and restart.
                </Callout>
              </div>
            )}
            <div className="mt-3 flex justify-center">
              <Link href={`/m/${id}`} className="text-sm font-medium text-brand hover:underline" target="_blank">
                Open the menu on this device
              </Link>
            </div>
          </Card>
          <Card title="So far tonight">
            <SalesStats state={state} />
            <p className="mt-3 text-sm text-ink-soft">
              Updates as PayPal confirms each payment. Cash sales are worked out at the end of the night from the closing count.
            </p>
          </Card>
        </div>
      )}

      {night.status === "setup" && (
        <Callout tone="info" title="The booth QR code opens after the opening count">
          Fans can only pay once the stocked table has been counted and checked, so every sale is measured against it.
        </Callout>
      )}

      {!selling && night.status !== "setup" && (
        <Card title="Sales">
          <SalesStats state={state} />
          {recon.expectedBoxCents !== null && recon.cash.status === "agree" && (
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Expected cash sales" value={formatCents(recon.expectedCashSalesCents ?? 0)} />
              <Stat label="Total sales" value={formatCents(recon.totalSalesCents ?? 0)} />
              <Stat label="Expected in box" value={formatCents(recon.expectedBoxCents)} hint="cash sales + float" />
              <Stat
                label="Cash difference"
                value={<Variance cents={recon.cashVarianceCents} band={recon.cashBand} />}
                tone={bandTone(recon.cashBand)}
              />
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <LinkButton href={`/nights/${id}/close`} variant="secondary">Close-out details</LinkButton>
            {(night.status === "closed" || night.status === "deposited") && (
              <LinkButton href={`/nights/${id}/deposit`} variant="secondary">Deposit</LinkButton>
            )}
          </div>
        </Card>
      )}

      {night.closeNote && (
        <Callout tone="warn" title="Note left when the night was finalized">
          {night.closeNote}
        </Callout>
      )}

      <Card title="Orders" aside={<span className="text-sm text-muted">{state.orders.length} total</span>}>
        <OrderList orders={state.orders} people={state.people} canRefund={live && !night.sample} />
        {!live && state.orders.some((o) => o.status === "COMPLETED") && (
          <p className="mt-3 text-xs text-muted">Refunds are available here until the night is finalized.</p>
        )}
      </Card>

      <div className="grid gap-5 md:grid-cols-2">
        <ReimbursementSummary state={state} />
        <NoticeSummary state={state} />
      </div>

      <AuditTrail rows={listAudit(id)} />
    </div>
  );
}

function SalesStats({ state }: { state: NightState }) {
  const { recon } = state;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <Stat label="PayPal orders" value={recon.paypalOrders} />
      <Stat label="PayPal sales" value={formatCents(recon.paypalCents)} />
      <Stat label="Items paid digitally" value={recon.paypalUnits} hint={recon.refundedOrders ? `${recon.refundedOrders} refunded` : undefined} />
    </div>
  );
}

function ReimbursementSummary({ state }: { state: NightState }) {
  const list = state.reimbursements;
  const onPayPal = list.filter(payoutUnconfirmed);
  const waiting = list.filter((r) => r.status === "requested" && !payoutUnconfirmed(r));
  const sent = list.filter((r) => r.status === "sent");
  const total = list.reduce((s, r) => s + r.cents, 0);
  return (
    <Card title="Supply reimbursements" aside={<Link href={`/nights/${state.night.id}/reimburse`} className="text-sm font-medium text-brand hover:underline">{list.length ? "Manage" : "Request one"}</Link>}>
      {list.length ? (
        <div className="space-y-2 text-sm">
          <p className="text-ink">
            {list.length} {list.length === 1 ? "request" : "requests"}, <span className="font-semibold tabular">{formatCents(total)}</span> in all.
          </p>
          <div className="flex flex-wrap gap-2">
            {waiting.length > 0 && <Pill tone="warn">{waiting.length} waiting for approval</Pill>}
            {onPayPal.length > 0 && <Pill tone="warn">{onPayPal.length} waiting on PayPal</Pill>}
            {sent.length > 0 && <Pill tone="ok">{sent.length} sent with PayPal</Pill>}
            {list.some((r) => r.status === "failed") && <Pill tone="bad">Payout failed</Pill>}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted">A parent who bought supplies can be repaid with PayPal once a second person approves.</p>
      )}
    </Card>
  );
}

function NoticeSummary({ state }: { state: NightState }) {
  const notices = state.notices;
  return (
    <Card title="Notices for officers" aside={notices.length ? <Link href="/notices" className="text-sm font-medium text-brand hover:underline">Open inbox</Link> : undefined}>
      {notices.length ? (
        <ul className="space-y-2">
          {notices.slice(0, 3).map((n) => (
            <li key={n.id} className="text-sm">
              <div className="flex items-center gap-2">
                <Pill tone={n.level === "red" ? "bad" : n.level === "amber" ? "warn" : "info"}>{n.level === "info" ? "Info" : "Difference"}</Pill>
                <LocalTime iso={n.createdAt} style="date" className="text-xs text-muted" />
              </div>
              <p className="mt-1 font-medium text-ink">{n.title}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">None. If the cash count or the deposit is different from what was expected, the officers get a notice here.</p>
      )}
    </Card>
  );
}
