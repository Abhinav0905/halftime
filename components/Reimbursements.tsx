"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { Person, Reimbursement } from "@/lib/repo";
import { formatCents, parseDollarInput } from "@/lib/money";
import { postJson } from "./api";
import { LocalTime } from "./LocalTime";
import { PersonSelect } from "./PersonSelect";
import { PhotoCapture } from "./count/PhotoCapture";
import { PAYOUT_TONE } from "./format";
import { Callout, Card, Field, Pill, buttonClass, inputClass } from "./ui";

const MAX_CENTS = 50_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ReimbursementRequestForm({ nightId, people }: { nightId: string; people: Person[] }) {
  const router = useRouter();
  const [requester, setRequester] = useState("");
  const [email, setEmail] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [receipt, setReceipt] = useState<string | null>(null);
  const [photoKey, setPhotoKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function pickRequester(name: string) {
    setRequester(name);
    const known = people.find((p) => p.name === name)?.email;
    if (known && !email) setEmail(known);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    const cents = parseDollarInput(amount);
    if (!requester) return setError("Choose who paid for the supplies.");
    if (!EMAIL.test(email.trim())) return setError("Enter the PayPal email address of the person to repay.");
    if (cents === null || cents <= 0) return setError("Enter the amount from the receipt, like 42.18.");
    if (cents > MAX_CENTS) return setError(`Requests over ${formatCents(MAX_CENTS)} go through the treasurer directly.`);
    if (!memo.trim()) return setError("Say what the money was for, like “Costco: hot dogs and buns”.");
    setBusy(true);
    const res = await postJson<{ id: string }>(`/api/nights/${encodeURIComponent(nightId)}/reimbursements`, {
      requester,
      payeeEmail: email.trim(),
      cents,
      memo: memo.trim(),
      ...(receipt ? { receiptSha256: receipt } : {}),
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setDone(`Request saved. Someone other than ${requester} needs to approve it below.`);
    setRequester("");
    setEmail("");
    setAmount("");
    setMemo("");
    setReceipt(null);
    setPhotoKey((k) => k + 1);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <PersonSelect label="Who paid for the supplies" people={people} value={requester} onChange={pickRequester} />
        <Field label="Their PayPal email" hint="Use a PayPal sandbox personal account for the demo.">
          <input
            type="email"
            className={inputClass}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            inputMode="email"
            placeholder="parent@example.com"
          />
        </Field>
        <Field label="Amount" hint={`Up to ${formatCents(MAX_CENTS)}.`}>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">$</span>
            <input className={`${inputClass} pl-7 tabular`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" />
          </div>
        </Field>
        <Field label="What it was for">
          <input className={inputClass} value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={120} placeholder="Costco: hot dogs, buns, water" />
        </Field>
      </div>
      <div>
        <span className="mb-1 block text-sm font-medium text-ink">Receipt photo (optional)</span>
        <PhotoCapture key={photoKey} nightId={nightId} purpose="receipt" label="Photograph the receipt" onUploaded={(p) => setReceipt(p.sha256)} />
        {receipt && <p className="mt-1 text-xs text-ok">Receipt photo saved.</p>}
      </div>
      {error && <p role="alert" className="text-sm font-medium text-bad">{error}</p>}
      {done && <p role="status" className="text-sm font-medium text-ok">{done}</p>}
      <button type="submit" className={`${buttonClass("primary", "lg")} w-full sm:w-auto`} disabled={busy}>
        {busy ? "Saving…" : "Request reimbursement"}
      </button>
    </form>
  );
}

export function ReimbursementCard({
  item,
  people,
  openingCountDone,
}: {
  item: Reimbursement;
  people: Person[];
  openingCountDone: boolean;
}) {
  const router = useRouter();
  const [approver, setApprover] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "refresh" | null>(null);

  async function approve() {
    setError(null);
    if (!approver) return setError("Choose who is approving.");
    setBusy("approve");
    const res = await postJson<{ status: string; payoutStatus: string | null; batchId: string | null }>(
      `/api/reimbursements/${encodeURIComponent(item.id)}/approve`,
      { approver },
    );
    setBusy(null);
    if (!res.ok) return setError(res.error);
    router.refresh();
  }

  async function refresh() {
    setError(null);
    setBusy("refresh");
    const res = await postJson(`/api/reimbursements/${encodeURIComponent(item.id)}/refresh`);
    setBusy(null);
    if (!res.ok) return setError(res.error);
    router.refresh();
  }

  const statusPill =
    item.status === "requested" ? (
      <Pill tone="warn">Waiting for approval</Pill>
    ) : item.status === "sent" ? (
      <Pill tone="ok">{item.batchId?.startsWith("SIM-") ? "Recorded (offline demo)" : "Sent with PayPal"}</Pill>
    ) : (
      <Pill tone="bad">Payout failed</Pill>
    );

  return (
    <Card>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xl font-bold tabular text-ink">{formatCents(item.cents)}</span>
            {statusPill}
          </div>
          <p className="mt-1 text-ink">{item.memo}</p>
          <p className="mt-1 text-sm text-muted">
            Requested by {item.requester} · to <span className="break-all">{item.payeeEmail}</span> · <LocalTime iso={item.createdAt} />
          </p>
        </div>
        {item.receiptSha256 && (
          <a href={`/api/photos/${item.receiptSha256}`} target="_blank" rel="noreferrer" className="shrink-0">
            <img src={`/api/photos/${item.receiptSha256}`} alt={`Receipt for ${item.memo}`} className="size-20 rounded-lg border border-line object-cover" />
          </a>
        )}
      </div>

      {item.status === "requested" && (
        <div className="mt-4 border-t border-line pt-4">
          {openingCountDone ? (
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1">
                <PersonSelect
                  label="Approved by"
                  people={people}
                  value={approver}
                  onChange={setApprover}
                  exclude={[item.requester]}
                  hint={`Someone other than ${item.requester}. Approving sends the money with PayPal Payouts.`}
                />
              </div>
              <button type="button" className={buttonClass("primary", "lg")} disabled={busy !== null} onClick={approve}>
                {busy === "approve" ? "Sending…" : `Approve and send ${formatCents(item.cents)}`}
              </button>
            </div>
          ) : (
            <Callout tone="info">Approval opens after the opening count, so the receipt can be checked against the stock on the table.</Callout>
          )}
        </div>
      )}

      {item.status !== "requested" && (
        <div className="mt-4 border-t border-line pt-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            {item.approver && (
              <>
                <dt className="text-muted">Approved by</dt>
                <dd className="text-ink">{item.approver}</dd>
              </>
            )}
            <dt className="text-muted">Payout batch</dt>
            <dd className="break-all font-mono text-ink">{item.batchId ?? "—"}</dd>
            <dt className="text-muted">PayPal status</dt>
            <dd>
              {item.payoutStatus ? <Pill tone={PAYOUT_TONE[item.payoutStatus] ?? "neutral"}>{item.payoutStatus}</Pill> : <span className="text-muted">—</span>}
            </dd>
            {item.error && (
              <>
                <dt className="text-muted">Problem</dt>
                <dd className="text-bad">{item.error}</dd>
              </>
            )}
          </dl>
          {item.payoutStatus === "UNCLAIMED" && (
            <p className="mt-2 text-xs text-muted">Unclaimed means the email has no PayPal account yet. PayPal holds the money for 30 days.</p>
          )}
          {item.batchId && (
            <button type="button" className={`${buttonClass("secondary")} mt-3`} disabled={busy !== null} onClick={refresh}>
              {busy === "refresh" ? "Checking…" : "Refresh status"}
            </button>
          )}
        </div>
      )}

      {error && <p role="alert" className="mt-3 text-sm font-medium text-bad">{error}</p>}
    </Card>
  );
}
