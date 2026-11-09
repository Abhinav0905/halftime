"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { postJson } from "./api";
import { buttonClass, cx } from "./ui";

/** A button that POSTs to an API route, optionally after a confirm prompt, then refreshes the page. */
export function ActionButton({
  url,
  label,
  pendingLabel,
  confirm,
  body,
  variant = "secondary",
  redirectTo,
  className,
}: {
  url: string;
  label: string;
  pendingLabel?: string;
  confirm?: string;
  body?: unknown;
  variant?: "primary" | "secondary" | "danger" | "gold";
  redirectTo?: string;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function run() {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    setError(null);
    const res = await postJson(url, body);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    startTransition(() => {
      if (redirectTo) router.push(redirectTo);
      router.refresh();
    });
  }

  return (
    <span className={cx("inline-flex flex-col items-start gap-1", className)}>
      <button type="button" onClick={run} disabled={busy} className={buttonClass(variant)}>
        {busy ? pendingLabel ?? "Working…" : label}
      </button>
      {error && (
        <span role="alert" className="text-xs font-medium text-bad">
          {error}
        </span>
      )}
    </span>
  );
}
