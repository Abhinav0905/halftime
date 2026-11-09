"use client";

import { useState, type FormEvent } from "react";
import { postJson } from "@/components/api";
import { Field, buttonClass, inputClass } from "@/components/ui";

export function StaffSignIn({ next }: { next: string }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!pin.trim()) return setError("Enter the staff PIN.");
    setBusy(true);
    const res = await postJson<{ ok: true; next: string }>("/api/staff", { pin, next });
    if (!res.ok) {
      setBusy(false);
      setPin("");
      return setError(res.error);
    }
    // A full page load, so the header and every server page pick up the new cookie.
    window.location.assign(res.data.next);
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field label="Staff PIN" hint="Ask the club treasurer if you don't have it.">
        <input
          className={`${inputClass} text-xl tracking-widest`}
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          autoComplete="current-password"
          autoFocus
        />
      </Field>
      {error && <p role="alert" className="text-sm font-medium text-bad">{error}</p>}
      <button type="submit" className={`${buttonClass("primary", "lg")} w-full`} disabled={busy}>
        {busy ? "Checking…" : "Sign in"}
      </button>
    </form>
  );
}

export function StaffSignOut() {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/staff", { method: "DELETE" });
    } finally {
      window.location.assign("/staff");
    }
  }

  return (
    <button type="button" className={buttonClass("secondary")} onClick={signOut} disabled={busy}>
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
