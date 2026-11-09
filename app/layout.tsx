import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { ensureSeeded } from "@/lib/seed";
import { getClub, unreadNoticeCount } from "@/lib/repo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Halftime",
  description: "Concession stand close-out for booster clubs: two photos and PayPal's itemized sales show how much cash should be in the box.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1d3a6e",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  ensureSeeded();
  const club = getClub();
  const unread = unreadNoticeCount();
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <header className="bg-brand text-white">
          <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">
            <Link href="/" className="flex items-baseline gap-2">
              <span className="text-lg font-bold tracking-tight">Halftime</span>
              <span className="hidden text-sm text-white/70 sm:inline">{club.name}</span>
            </Link>
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
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-5xl px-4 pb-8 text-xs text-muted">
          PayPal sandbox only. No real money moves.
        </footer>
      </body>
    </html>
  );
}
