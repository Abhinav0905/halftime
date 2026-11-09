// Shared presentational pieces. Server- and client-safe (no hooks here).

import Link from "next/link";
import type { ReactNode } from "react";
import { formatCents, formatVariance } from "@/lib/money";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function PageHeader({ title, subtitle, back, actions }: { title: string; subtitle?: ReactNode; back?: { href: string; label: string }; actions?: ReactNode }) {
  return (
    <div className="mb-6">
      {back && (
        <Link href={back.href} className="mb-2 inline-block text-sm text-brand hover:underline">← {back.label}</Link>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight text-ink">{title}</h1>
          {subtitle && <div className="mt-1 text-sm text-muted">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Card({ children, className, title, aside }: { children: ReactNode; className?: string; title?: ReactNode; aside?: ReactNode }) {
  return (
    <section className={cx("rounded-xl border border-line bg-card p-4 shadow-sm sm:p-5", className)}>
      {(title || aside) && (
        <div className="mb-3 flex items-center gap-2">
          {title && <h2 className="text-base font-semibold text-ink">{title}</h2>}
          {aside && <div className="ml-auto">{aside}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

const BUTTON = {
  primary: "bg-brand text-white hover:bg-brand/90 disabled:bg-brand/40",
  secondary: "bg-white text-ink border border-line hover:bg-paper disabled:text-muted",
  danger: "bg-white text-bad border border-bad/40 hover:bg-bad-soft disabled:text-muted",
  gold: "bg-gold text-ink hover:bg-gold/90 disabled:bg-gold/40",
} as const;

export function buttonClass(variant: keyof typeof BUTTON = "primary", size: "md" | "lg" = "md"): string {
  return cx(
    "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed",
    size === "lg" ? "min-h-12 px-5 text-base" : "min-h-10 px-4 text-sm",
    BUTTON[variant],
  );
}

export function LinkButton({ href, children, variant = "primary", size = "md" }: { href: string; children: ReactNode; variant?: keyof typeof BUTTON; size?: "md" | "lg" }) {
  return <Link href={href} className={buttonClass(variant, size)}>{children}</Link>;
}

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

const TONE: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  info: "bg-brand-soft text-brand",
  neutral: "bg-paper text-ink-soft border border-line",
};

export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold", TONE[tone])}>{children}</span>;
}

export function bandTone(band: string | null | undefined): Tone {
  if (band === "green") return "ok";
  if (band === "amber") return "warn";
  if (band === "red") return "bad";
  return "neutral";
}

export function Money({ cents, className }: { cents: number | null | undefined; className?: string }) {
  return <span className={cx("tabular", className)}>{cents === null || cents === undefined ? "—" : formatCents(cents)}</span>;
}

export function Variance({ cents, band }: { cents: number | null | undefined; band?: string | null }) {
  if (cents === null || cents === undefined) return <span className="text-muted">—</span>;
  return <Pill tone={bandTone(band ?? (cents === 0 ? "green" : null))}><span className="tabular">{formatVariance(cents)}</span></Pill>;
}

const STATUS_LABEL: Record<string, { label: string; tone: Tone }> = {
  setup: { label: "Opening count", tone: "info" },
  selling: { label: "Selling", tone: "ok" },
  closing: { label: "Closing", tone: "warn" },
  closed: { label: "Closed, awaiting deposit", tone: "warn" },
  deposited: { label: "Deposited", tone: "neutral" },
};

export function NightStatusPill({ status }: { status: string }) {
  const s = STATUS_LABEL[status] ?? { label: status, tone: "neutral" as Tone };
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className={cx("rounded-lg border border-line p-3", tone && tone !== "neutral" ? TONE[tone] : "bg-white")}>
      <div className="text-xs font-medium uppercase tracking-wide opacity-75">{label}</div>
      <div className="mt-1 text-xl font-bold tabular">{value}</div>
      {hint && <div className="mt-0.5 text-xs opacity-80">{hint}</div>}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-muted">{hint}</span>}
      {error && <span className="mt-1 block text-xs font-medium text-bad">{error}</span>}
    </label>
  );
}

export const inputClass = "block w-full rounded-lg border border-line bg-white px-3 py-2.5 text-base text-ink placeholder:text-muted focus:border-brand focus:outline-none";

export function Callout({ tone = "info", title, children }: { tone?: Tone; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={cx("rounded-lg p-3 text-sm", TONE[tone])}>
      {title && <div className="font-semibold">{title}</div>}
      {children && <div className={title ? "mt-1" : undefined}>{children}</div>}
    </div>
  );
}
