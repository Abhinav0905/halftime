import type { Metadata } from "next";
import type { ReactNode } from "react";
import { band, reconcile, type ReconcileInput } from "@/lib/engine/reconcile";
import { ITEMS } from "@/lib/seed";
import { formatCents, formatVariance } from "@/lib/money";
import { Card, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "How it works" };

// A made-up game using the real menu. The numbers below are computed by the
// same reconcile() the app uses, so the page can't drift from the code.
const OPEN = { water: 48, sports: 24, chips: 30, candy: 36, hotdog: 40 };
const CLOSE = { water: 20, sports: 10, chips: 12, candy: 16, hotdog: 6 };
const WASTE = { hotdog: 2 };
const PAYPAL_UNITS = { water: 10, sports: 6, chips: 7, candy: 8, hotdog: 15 } as Record<string, number>;
const FLOAT = 10_000;
const TOLERANCE = 100;

function example(close: Record<string, number>): ReturnType<typeof reconcile> {
  const catalog = ITEMS.map((i) => ({ sku: i.sku, name: i.name, priceCents: i.priceCents }));
  const lines = catalog.map((i) => ({ sku: i.sku, quantity: PAYPAL_UNITS[i.sku] ?? 0 }));
  const totalCents = catalog.reduce((s, i) => s + (PAYPAL_UNITS[i.sku] ?? 0) * i.priceCents, 0);
  const input: ReconcileInput = {
    items: catalog,
    open: OPEN,
    close,
    waste: WASTE,
    orders: [{ status: "COMPLETED", items: lines, totalCents }],
    floatCents: FLOAT,
    cashCounts: [],
    depositCents: null,
    toleranceCents: TOLERANCE,
  };
  return reconcile(input);
}

export default function HowItWorksPage() {
  const r = example(CLOSE);
  const recount = example({ ...CLOSE, sports: 19 }).lines.find((l) => l.sku === "sports");
  const expectedBox = r.expectedBoxCents ?? 0;
  const short = -300;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="How Halftime works"
        subtitle="For new volunteers, officers and anyone checking the math."
      />

      <Section title="In short">
        <p>
          Halftime closes out a booster club&apos;s concession stand. Volunteers count the stock at the start and end of the game, fans can pay by
          PayPal or Venmo at a QR code, and PayPal&apos;s record of exactly which items were paid digitally tells you how much cash should be in the
          box.
        </p>
      </Section>

      <Section title="The formula">
        <ol className="list-decimal space-y-1 pl-5">
          <li>For each item, <strong>sold</strong> = opening count − closing count − waste.</li>
          <li><strong>Paid with PayPal</strong> = the units in completed PayPal orders. Refunded orders don&apos;t count.</li>
          <li><strong>Paid in cash</strong> = sold − paid with PayPal.</li>
          <li><strong>Expected in the box</strong> = each item&apos;s cash units × its price, added up, plus the opening float.</li>
        </ol>
        <p>All money is kept in whole cents, so nothing is lost to rounding.</p>
      </Section>

      <Section title="A worked example">
        <p>
          Opening float {formatCents(FLOAT)}. Two hot dogs were dropped and written down as waste.
        </p>
        <div className="-mx-4 overflow-x-auto sm:mx-0">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="px-2 py-2 text-left">Item</th>
                <th scope="col" className="px-2 py-2 text-right">Price</th>
                <th scope="col" className="px-2 py-2 text-right">Open</th>
                <th scope="col" className="px-2 py-2 text-right">Close</th>
                <th scope="col" className="px-2 py-2 text-right">Waste</th>
                <th scope="col" className="px-2 py-2 text-right">Sold</th>
                <th scope="col" className="px-2 py-2 text-right">PayPal</th>
                <th scope="col" className="px-2 py-2 text-right">Cash</th>
                <th scope="col" className="px-2 py-2 text-right">Cash $</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {r.lines.map((l) => (
                <tr key={l.sku} className="border-b border-line">
                  <th scope="row" className="px-2 py-2 text-left font-medium text-ink">{l.name}</th>
                  <td className="px-2 py-2 text-right">{formatCents(l.priceCents)}</td>
                  <td className="px-2 py-2 text-right">{l.open}</td>
                  <td className="px-2 py-2 text-right">{l.close}</td>
                  <td className="px-2 py-2 text-right">{l.waste || "—"}</td>
                  <td className="px-2 py-2 text-right font-semibold text-ink">{l.sold}</td>
                  <td className="px-2 py-2 text-right">{l.paypalUnits}</td>
                  <td className="px-2 py-2 text-right">{l.cashUnits}</td>
                  <td className="px-2 py-2 text-right font-semibold text-ink">{l.cashCents === null ? "—" : formatCents(l.cashCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="space-y-1">
          <li>Cash sales: <strong className="tabular">{formatCents(r.expectedCashSalesCents ?? 0)}</strong>. Add the float, and the box should hold <strong className="tabular">{formatCents(expectedBox)}</strong>.</li>
          <li>PayPal sales: <strong className="tabular">{formatCents(r.paypalCents)}</strong>, so the stand made <strong className="tabular">{formatCents(r.totalSalesCents ?? 0)}</strong> in all.</li>
          <li>
            If the two volunteers both count {formatCents(expectedBox + short)}, the difference is {formatVariance(short)}. That is more than the{" "}
            {formatCents(TOLERANCE)} allowance for making change, so it shows as {band(short, TOLERANCE)} and the officers get a notice.
            The next morning, the deposit should be the counted cash minus the float.
          </li>
        </ul>
      </Section>

      <Section title="The five steps">
        <ol className="space-y-3">
          <Step n={1} title="Opening count">
            Before the stand opens, a volunteer photographs the stocked table. The app suggests a count for each item, the volunteer fixes any
            mistakes, and a second volunteer checks it. The booth QR code only opens after this.
          </Step>
          <Step n={2} title="Selling">
            Fans scan the QR code, pick items and pay with PayPal or Venmo. The server prices the order from the club&apos;s menu and sends PayPal an
            itemized order. Once PayPal confirms the payment, the window board shows a three-character pickup code. Cash sales carry on as usual.
          </Step>
          <Step n={3} title="Closing count and cash">
            After the game, a volunteer photographs the leftovers and notes any waste; a second volunteer checks. Then two volunteers count the cash
            box one after the other, without seeing each other&apos;s number or the expected amount. Once the counts match, the app shows expected
            against counted, and the night is finalized.
          </Step>
          <Step n={4} title="Deposit">
            The next day, someone who did not count the cash takes it to the bank and enters the amount on the slip. If it differs from the counted
            cash minus the float, the officers get a notice.
          </Step>
          <Step n={5} title="Reimbursing supplies">
            A parent who bought hot dogs or water enters the receipt. Someone else approves it, and the money goes to the parent&apos;s PayPal
            account through PayPal Payouts.
          </Step>
        </ol>
      </Section>

      <Section title="Why PayPal's itemized sales matter">
        <p>
          <strong>They make the digital half exact.</strong> Every PayPal order lists the items and quantities. After capturing a payment, the
          server reads the order back from PayPal and stores PayPal&apos;s own line items, not what the browser sent. Only the cash half has to be
          worked out from the counts.
        </p>
        <p>
          <strong>They put a floor under the counts.</strong> A stand can&apos;t sell fewer sports drinks than PayPal recorded. If the closing photo
          had counted 19 sports drinks instead of 10, the app would stop and ask for a recount:
        </p>
        {recount?.recountReason && (
          <blockquote className="rounded-lg border-l-4 border-warn bg-warn-soft px-3 py-2 text-ink">{recount.recountReason}</blockquote>
        )}
        <p>
          <strong>Refunds stay in step.</strong> A refunded order leaves the PayPal column straight away, so its items count as unsold or as cash,
          depending on what the closing count shows.
        </p>
      </Section>

      <Section title="What the photo count does, and what it doesn't">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-ok-soft p-3">
            <h3 className="font-semibold text-ok">It does</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>Suggest a count for each menu item from one photo.</li>
              <li>Draw a numbered box on each item it counted, so the volunteer can check them one by one.</li>
              <li>Mark counts it is unsure of, and photo problems like glare or stacked items.</li>
            </ul>
          </div>
          <div className="rounded-lg bg-paper p-3 ring-1 ring-line">
            <h3 className="font-semibold text-ink">It doesn&apos;t</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>Save anything by itself. A volunteer confirms every number and a second volunteer checks.</li>
              <li>Touch money. Every dollar figure comes from plain arithmetic on confirmed counts and PayPal records.</li>
              <li>Decide anything about a person.</li>
            </ul>
          </div>
        </div>
        <p>If the photo service is unavailable, volunteers type the counts by hand and everything else works the same.</p>
      </Section>

      <Section title="Separation of duties">
        <ul className="list-disc space-y-1 pl-5">
          <li>Each stock count is made by one volunteer and checked by a different one.</li>
          <li>The cash box is counted twice, by two different people, blind.</li>
          <li>The person who makes the deposit can&apos;t be one of the cash counters.</li>
          <li>A reimbursement is approved by someone other than the person asking for it.</li>
          <li>Differences go to the officers as notices. A notice says which numbers disagree; it doesn&apos;t say why.</li>
        </ul>
      </Section>

      <Section title="Limits of this prototype">
        <ul className="list-disc space-y-1 pl-5">
          <li>It runs against the PayPal sandbox only. No real money moves.</li>
          <li>There is no sign-in yet. Volunteers pick their names from the roster, so the rules above rely on people choosing honestly.</li>
          <li>Photo counts need a flat, well-lit table with items side by side, not stacked. Foil-wrapped items are the hardest to count.</li>
          <li>Free items, like hot dogs for the referees, show up as a difference unless they are written down as waste.</li>
        </ul>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card title={title}>
      <div className="space-y-3 text-sm leading-relaxed text-ink-soft">{children}</div>
    </Card>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-bold text-white" aria-hidden>
        {n}
      </span>
      <div>
        <h3 className="font-semibold text-ink">{title}</h3>
        <p className="mt-0.5">{children}</p>
      </div>
    </li>
  );
}
