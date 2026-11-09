"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { Person } from "@/lib/repo";
import type { CashStatus } from "@/lib/engine/reconcile";
import { parseDollarInput } from "@/lib/money";
import { postJson } from "./api";
import { PersonSelect } from "./PersonSelect";
import { Callout, Field, buttonClass, inputClass } from "./ui";

/**
 * Blind cash count. The form never shows the expected amount or anyone
 * else's count; the server page only reveals them once two counts agree.
 */
export function CashCountForm({
  nightId,
  people,
  status,
  lastCounter,
}: {
  nightId: string;
  people: Person[];
  status: Exclude<CashStatus, "agree">;
  lastCounter: string | null;
}) {
  const router = useRouter();
  const [countedBy, setCountedBy] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!countedBy) return setError("Choose who counted the box.");
    const cents = parseDollarInput(amount);
    if (cents === null) return setError("Enter the total in dollars, like 214 or 214.50.");
    setBusy(true);
    const res = await postJson<{ ok: true; cash: { status: CashStatus; countedCents: number | null } }>(
      `/api/nights/${encodeURIComponent(nightId)}/cash`,
      { countedBy, cents },
    );
    setBusy(false);
    if (!res.ok) return setError(res.error);
    const who = countedBy.split(" ")[0] ?? countedBy;
    setSaved(
      res.data.cash.status === "agree"
        ? `Thanks, ${who}. Both counts match.`
        : res.data.cash.status === "disagree"
          ? `Thanks, ${who}. Your count is different from the one before it, so the box needs another count.`
          : `Thanks, ${who}. Your count is saved. Hand the box to a second volunteer to count on their own.`,
    );
    setCountedBy("");
    setAmount("");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="max-w-md space-y-4" noValidate>
      {status === "disagree" && (
        <Callout tone="warn" title="The two counts are different">
          Please count the box again, carefully, and enter the new total. The next count has to be by someone other than{" "}
          {lastCounter ?? "the last counter"}. Earlier numbers stay hidden so each count is independent.
        </Callout>
      )}
      {saved && (
        <div role="status" className="rounded-lg bg-ok-soft p-3 text-sm font-medium text-ok">
          {saved}
        </div>
      )}
      <PersonSelect
        label={status === "missing" ? "Who is counting first" : "Who is counting now"}
        people={people}
        value={countedBy}
        onChange={setCountedBy}
        exclude={lastCounter ? [lastCounter] : []}
        hint={lastCounter ? `${lastCounter} counted last, so someone else counts now.` : undefined}
      />
      <Field label="Total cash in the box, including the float" hint="Count every bill and coin. You will not see the expected amount until both counts are in.">
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
      {error && <p role="alert" className="text-sm font-medium text-bad">{error}</p>}
      <button type="submit" className={`${buttonClass("primary", "lg")} w-full sm:w-auto`} disabled={busy}>
        {busy ? "Saving…" : "Save my count"}
      </button>
    </form>
  );
}

export function FinalizeForm({
  nightId,
  people,
  noteRequired,
}: {
  nightId: string;
  people: Person[];
  noteRequired: boolean;
}) {
  const router = useRouter();
  const [by, setBy] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!by) return setError("Choose who is finalizing.");
    if (noteRequired && note.trim().length < 10) {
      return setError("Write a short note (at least 10 characters) about the items that still need a recount.");
    }
    setBusy(true);
    const res = await postJson(`/api/nights/${encodeURIComponent(nightId)}/finalize`, {
      by,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="max-w-sm">
        <PersonSelect label="Who is finalizing" people={people} value={by} onChange={setBy} />
      </div>
      <Field
        label={noteRequired ? "Note for the officers (required)" : "Note for the officers (optional)"}
        hint={
          noteRequired
            ? "Some items still need a recount. Say what happened, for example “Two hot dogs went to the referees.”"
            : "Anything the treasurer should know about tonight."
        }
      >
        <textarea className={`${inputClass} min-h-24`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
      {error && <p role="alert" className="text-sm font-medium text-bad">{error}</p>}
      <button type="submit" className={`${buttonClass("primary", "lg")} w-full sm:w-auto`} disabled={busy}>
        {busy ? "Finalizing…" : "Finalize close-out"}
      </button>
    </form>
  );
}
