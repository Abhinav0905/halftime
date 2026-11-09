import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ensureSeeded } from "@/lib/seed";
import { getClub, unreadNoticeCount } from "@/lib/repo";
import { SiteHeader } from "@/components/SiteHeader";

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
        <SiteHeader clubName={club.name} unread={unread} />
        <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-5xl px-4 pb-8 text-xs text-muted">
          PayPal sandbox only. No real money moves.
        </footer>
      </body>
    </html>
  );
}
