"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Notice } from "@/lib/repo";
import { postJson } from "./api";
import { LocalTime } from "./LocalTime";
import { Pill, cx } from "./ui";

const LEVEL = {
  red: { label: "Difference to review", tone: "bad", bar: "bg-bad" },
  amber: { label: "Small difference", tone: "warn", bar: "bg-warn" },
  info: { label: "For your information", tone: "info", bar: "bg-brand" },
} as const;

export interface NoticeWithGame extends Notice {
  game: { title: string; date: string } | null;
}

export function NoticeList({ notices }: { notices: NoticeWithGame[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);

  async function markRead(id: string) {
    setBusy(id);
    setError(null);
    const res = await postJson(`/api/notices/${encodeURIComponent(id)}/read`);
    setBusy(null);
    if (!res.ok) {
      setError({ id, message: res.error });
      return;
    }
    router.refresh();
  }

  return (
    <ul className="space-y-3">
      {notices.map((n) => {
        const level = LEVEL[n.level];
        const read = n.readAt !== null;
        return (
          <li key={n.id} className={cx("flex overflow-hidden rounded-xl border border-line bg-card shadow-sm", read && "opacity-70")}>
            <span className={cx("w-1.5 shrink-0", level.bar)} aria-hidden />
            <div className="min-w-0 flex-1 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={level.tone}>{level.label}</Pill>
                {!read && <span className="text-xs font-bold uppercase tracking-wide text-brand">New</span>}
                <LocalTime iso={n.createdAt} className="ml-auto text-xs text-muted" />
              </div>
              <h2 className="mt-2 text-base font-semibold text-ink">{n.title}</h2>
              <p className="mt-1 text-sm text-ink-soft">{n.body}</p>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                {n.nightId && (
                  <Link href={`/nights/${n.nightId}`} className="font-medium text-brand hover:underline">
                    {n.game ? `Open ${n.game.title}` : "Open the game"}
                  </Link>
                )}
                {read ? (
                  <span className="text-xs text-muted">
                    Read <LocalTime iso={n.readAt!} />
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => markRead(n.id)}
                    disabled={busy === n.id}
                    className="min-h-10 rounded-lg border border-line bg-white px-3 font-medium text-ink hover:bg-paper disabled:text-muted"
                  >
                    {busy === n.id ? "Saving…" : "Mark as read"}
                  </button>
                )}
              </div>
              {error?.id === n.id && (
                <p role="alert" className="mt-2 text-sm font-medium text-bad">
                  {error.message}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
