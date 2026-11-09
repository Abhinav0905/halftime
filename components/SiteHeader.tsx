"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getJson } from "./api";

/** Officer navigation. Fans on the buyer menu (/m/...) only see the club name. */
export function SiteHeader({ clubName, unread }: { clubName: string; unread: number }) {
  const pathname = usePathname() ?? "/";
  const buyer = pathname.startsWith("/m/");
  const signedIn = useStaffSignedIn(!buyer);
  const link = "rounded-md px-2 py-2 hover:bg-white/10 sm:px-3";

  async function signOut() {
    try {
      await fetch("/api/staff", { method: "DELETE" });
    } finally {
      window.location.assign("/staff");
    }
  }

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
          <nav className="ml-auto flex flex-wrap items-center justify-end gap-x-1 text-sm">
            <Link href="/ledger" className={link}>Season</Link>
            <Link href="/notices" className={`relative ${link}`}>
              Notices
              {unread > 0 && (
                <span className="ml-1 rounded-full bg-gold px-1.5 py-0.5 text-xs font-bold text-ink">{unread}</span>
              )}
            </Link>
            <Link href="/how-it-works" className={link}>How it works</Link>
            {signedIn && (
              <button type="button" onClick={signOut} className={`${link} text-white/80`}>
                Sign out
              </button>
            )}
          </nav>
        )}
      </div>
    </header>
  );
}

/** True only when the server has a staff PIN and this device is signed in. The cookie is HttpOnly, so ask the server. */
function useStaffSignedIn(enabled: boolean): boolean {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void getJson<{ pinRequired: boolean; signedIn: boolean }>("/api/staff").then((res) => {
      if (live && res.ok) setSignedIn(res.data.pinRequired && res.data.signedIn);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return signedIn;
}
