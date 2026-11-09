"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { parseDollarInput } from "@/lib/money";
import { postJson } from "./api";
import { todayLocalIso } from "./format";
import { Callout, Field, buttonClass, inputClass } from "./ui";

export function NewNightForm({ defaultDate }: { defaultDate: string }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [float, setFloat] = useState("100");
  const [errors, setErrors] = useState<{ title?: string; date?: string; float?: string }>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The server guessed "today" in its own time zone; use the volunteer's.
  useEffect(() => {
    setDate((d) => (d === defaultDate ? todayLocalIso() : d));
  }, [defaultDate]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const floatCents = parseDollarInput(float);
    const next: typeof errors = {};
    if (!title.trim()) next.title = "Give the game a name, like “vs. Westfield”.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) next.date = "Choose the date of the game.";
    if (floatCents === null) next.float = "Enter the float in dollars, like 100 or 75.50.";
    setErrors(next);
    if (Object.keys(next).length || floatCents === null) return;

    setBusy(true);
    setServerError(null);
    const res = await postJson<{ id: string }>("/api/nights", { title: title.trim(), date, floatCents });
    if (!res.ok) {
      setBusy(false);
      setServerError(res.error);
      return;
    }
    router.push(`/nights/${res.data.id}/count/open`);
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <Field label="Game" hint="Who you are playing, as people say it." error={errors.title}>
        <input
          className={inputClass}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="vs. Westfield"
          maxLength={80}
          autoComplete="off"
          autoFocus
          aria-invalid={Boolean(errors.title)}
        />
      </Field>
      <Field label="Date" error={errors.date}>
        <input type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={Boolean(errors.date)} />
      </Field>
      <Field label="Opening float" hint="Cash put in the box before the first sale, so you can make change." error={errors.float}>
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">$</span>
          <input
            className={`${inputClass} pl-7 tabular`}
            value={float}
            onChange={(e) => setFloat(e.target.value)}
            inputMode="decimal"
            aria-invalid={Boolean(errors.float)}
          />
        </div>
      </Field>
      {serverError && <Callout tone="bad" title="The game was not created">{serverError}</Callout>}
      <button type="submit" className={`${buttonClass("primary", "lg")} w-full sm:w-auto`} disabled={busy}>
        {busy ? "Creating…" : "Create game and count opening stock"}
      </button>
    </form>
  );
}
