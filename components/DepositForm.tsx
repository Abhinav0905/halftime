"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { Person } from "@/lib/repo";
import { parseDollarInput } from "@/lib/money";
import { postJson } from "./api";
import { PersonSelect } from "./PersonSelect";
import { PhotoCapture } from "./count/PhotoCapture";
import { Field, buttonClass, inputClass } from "./ui";

export function DepositForm({ nightId, people, cashCounters }: { nightId: string; people: Person[]; cashCounters: string[] }) {
  const router = useRouter();
  const [depositor, setDepositor] = useState("");
  const [amount, setAmount] = useState("");
  const [slip, setSlip] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!depositor) return setError("Choose who made the deposit.");
    const cents = parseDollarInput(amount);
    if (cents === null) return setError("Enter the amount on the deposit slip, like 114 or 114.50.");
    setBusy(true);
    const res = await postJson<{ ok: true; depositVarianceCents: number; band: string }>(
      `/api/nights/${encodeURIComponent(nightId)}/deposit`,
      { depositor, cents, ...(slip ? { slipSha256: slip } : {}) },
    );
    setBusy(false);
    if (!res.ok) return setError(res.error);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <PersonSelect
        label="Who made the deposit"
        people={people}
        value={depositor}
        onChange={setDepositor}
        exclude={cashCounters}
        hint={cashCounters.length ? `${cashCounters.join(" and ")} counted the cash, so someone else makes the deposit.` : undefined}
      />
      <Field label="Amount on the bank deposit slip" hint="Copy it from the receipt the bank gave you.">
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-lg text-muted">$</span>
          <input
            className={`${inputClass} pl-7 text-2xl font-semibold tabular`}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
          />
        </div>
      </Field>
      <div>
        <span className="mb-1 block text-sm font-medium text-ink">Photo of the slip (optional)</span>
        <PhotoCapture nightId={nightId} purpose="slip" label="Photograph the deposit slip" onUploaded={(p) => setSlip(p.sha256)} />
        {slip && <p className="mt-1 text-xs text-ok">Slip photo saved.</p>}
      </div>
      {error && <p role="alert" className="text-sm font-medium text-bad">{error}</p>}
      <button type="submit" className={`${buttonClass("primary", "lg")} w-full sm:w-auto`} disabled={busy}>
        {busy ? "Saving…" : "Record the deposit"}
      </button>
    </form>
  );
}
