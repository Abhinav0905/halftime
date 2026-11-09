import type { Metadata } from "next";
import Link from "next/link";
import { getClub, getLedger } from "@/lib/repo";
import { ensureSeeded } from "@/lib/seed";
import { formatCents, formatVariance } from "@/lib/money";
import { LedgerGrid } from "@/components/LedgerGrid";
import { formatGameDate } from "@/components/format";
import { Card, PageHeader, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Season ledger" };

export default function LedgerPage() {
  ensureSeeded();
  const rows = getLedger();
  const tolerance = getClub().toleranceCents;
  const priced = rows.filter((r) => r.totalSalesCents !== null);
  const totalSales = priced.reduce((s, r) => s + (r.totalSalesCents ?? 0), 0);
  const paypalOnPriced = priced.reduce((s, r) => s + r.paypalCents, 0);
  const paypalAll = rows.reduce((s, r) => s + r.paypalCents, 0);
  const deposited = rows.reduce((s, r) => s + (r.depositCents ?? 0), 0);
  const withDifferences = rows.filter(
    (r) => (r.cashBand !== null && r.cashBand !== "green") || (r.depositBand !== null && r.depositBand !== "green"),
  );
  const netCash = rows.reduce((s, r) => s + (r.cashVarianceCents ?? 0), 0);
  const netDeposit = rows.reduce((s, r) => s + (r.depositVarianceCents ?? 0), 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Season ledger"
        subtitle="One row per game: what PayPal recorded, what the cash should have been, what was counted and what reached the bank. Tap a row to open the game."
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Total sales" value={formatCents(totalSales)} hint={`${priced.length} of ${rows.length} games fully counted`} />
        <Stat
          label="PayPal sales"
          value={formatCents(paypalAll)}
          hint={totalSales ? `${Math.round((paypalOnPriced / totalSales) * 100)}% of counted sales` : undefined}
        />
        <Stat label="Deposited" value={formatCents(deposited)} />
        <Stat
          label="Games with differences"
          value={withDifferences.length}
          tone={withDifferences.length ? "warn" : "ok"}
          hint={`Net: cash ${formatVariance(netCash)}, deposits ${formatVariance(netDeposit)}`}
        />
      </div>

      {withDifferences.length > 0 && (
        <Card title="Games to look at">
          <ul className="space-y-1 text-sm">
            {withDifferences.map((r) => (
              <li key={r.nightId}>
                <Link href={`/nights/${r.nightId}`} className="font-medium text-brand hover:underline">
                  {r.title}
                </Link>{" "}
                <span className="text-ink-soft">
                  ({formatGameDate(r.date)}
                  {r.sample ? ", sample" : ""}):{" "}
                  {[
                    r.cashBand && r.cashBand !== "green" && r.cashVarianceCents !== null ? `cash ${formatVariance(r.cashVarianceCents)}` : null,
                    r.depositBand && r.depositBand !== "green" && r.depositVarianceCents !== null ? `deposit ${formatVariance(r.depositVarianceCents)}` : null,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <LedgerGrid rows={rows} />
      <p className="text-xs text-muted">
        Variance colors: green is within {formatCents(tolerance)}, amber within {formatCents(tolerance * 5)}, red beyond that. Rows marked Sample are demo data.
      </p>
    </div>
  );
}
