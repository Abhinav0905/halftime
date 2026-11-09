// Per-item close-out table. Cash columns stay hidden until both cash counts
// are in, so the people counting the box are not steered by the expected total.

import type { ItemResult } from "@/lib/engine/reconcile";
import { formatCents } from "@/lib/money";
import { cx } from "./ui";

const num = (v: number | null) => (v === null ? "—" : String(v));

export function ReconTable({ lines, revealCash }: { lines: ItemResult[]; revealCash: boolean }) {
  const anyRecount = lines.some((l) => l.recount);
  const totals = {
    sold: lines.reduce((s, l) => s + Math.max(0, l.sold ?? 0), 0),
    paypal: lines.reduce((s, l) => s + l.paypalUnits, 0),
    cash: lines.reduce((s, l) => s + (l.cashUnits ?? 0), 0),
    cashCents: lines.reduce((s, l) => s + (l.cashCents ?? 0), 0),
  };
  const head = "px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted whitespace-nowrap";
  const th = `${head} text-right`;
  const td = "px-3 py-2.5 text-right tabular";

  return (
    <div className="-mx-4 overflow-x-auto sm:mx-0">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <caption className="sr-only">Units sold per item: opening count minus closing count minus waste, split into PayPal and cash.</caption>
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={`${head} sticky left-0 bg-card text-left`}>Item</th>
            <th scope="col" className={th}>Opening</th>
            <th scope="col" className={th}>Closing</th>
            <th scope="col" className={th}>Waste</th>
            <th scope="col" className={th}>Sold</th>
            <th scope="col" className={th}>PayPal</th>
            <th scope="col" className={th}>Cash</th>
            <th scope="col" className={th}>Cash $</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.sku} className={cx("border-b border-line align-top", l.recount && "bg-warn-soft")}>
              <th scope="row" className={cx("sticky left-0 px-3 py-2.5 text-left font-medium", l.recount ? "bg-warn-soft" : "bg-card")}>
                <div className="text-ink">{l.name}</div>
                <div className="text-xs font-normal text-muted">{formatCents(l.priceCents)} each</div>
                {l.recount && l.recountReason && (
                  <div className="mt-1 max-w-56 text-xs font-medium text-warn">Recount: {l.recountReason}</div>
                )}
              </th>
              <td className={td}>{num(l.open)}</td>
              <td className={td}>{num(l.close)}</td>
              <td className={td}>{l.waste || "—"}</td>
              <td className={cx(td, "font-semibold text-ink")}>{num(l.sold)}</td>
              <td className={td}>{l.paypalUnits}</td>
              <td className={td}>{revealCash ? num(l.cashUnits) : <Hidden />}</td>
              <td className={cx(td, "font-semibold text-ink")}>
                {revealCash ? (l.cashCents === null ? "—" : formatCents(l.cashCents)) : <Hidden />}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold text-ink">
            <th scope="row" className="sticky left-0 bg-card px-3 py-2.5 text-left">Total</th>
            <td className={td} />
            <td className={td} />
            <td className={td} />
            <td className={td}>{totals.sold}</td>
            <td className={td}>{totals.paypal}</td>
            <td className={td}>{revealCash ? (anyRecount ? "—" : totals.cash) : <Hidden />}</td>
            <td className={td}>{revealCash ? (anyRecount ? "—" : formatCents(totals.cashCents)) : <Hidden />}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Hidden() {
  return (
    <span className="text-muted" title="Shown after both cash counts are in">
      <span aria-hidden>••</span>
      <span className="sr-only">hidden until the cash is counted</span>
    </span>
  );
}
