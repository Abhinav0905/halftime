"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Officer navigation. Fans on the buyer menu (/m/...) only see the club name. */
export function SiteHeader({ clubName, unread }: { clubName: string; unread: number }) {
  const pathname = usePathname() ?? "/";
  const buyer = pathname.startsWith("/m/");
  return (
    <header className="bg-brand text-white">
      <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">
        {buyer ? (
          <span className="flex items-baseline gap-2">
            <span className="text-lg font-bold tracking-tight">{clubName}</span>
          </span>
        ) : (
          <Link href="/" className="flex items-baseline gap-2">
            <span className="text-lg font-bold tracking-tight">Halftime</span>
            <span className="hidden text-sm text-white/70 sm:inline">{clubName}</span>
          </Link>
        )}
        {!buyer && (
          <nav className="ml-auto flex items-center gap-1 text-sm">
            <Link href="/ledger" className="rounded-md px-3 py-2 hover:bg-white/10">Season</Link>
            <Link href="/notices" className="relative rounded-md px-3 py-2 hover:bg-white/10">
              Notices
              {unread > 0 && (
                <span className="ml-1 rounded-full bg-gold px-1.5 py-0.5 text-xs font-bold text-ink">{unread}</span>
              )}
            </Link>
            <Link href="/how-it-works" className="rounded-md px-3 py-2 hover:bg-white/10">How it works</Link>
          </nav>
        )}
      </div>
    </header>
  );
}
