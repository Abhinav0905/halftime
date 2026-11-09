import type { Metadata } from "next";
import { listNights, listNotices } from "@/lib/repo";
import { ensureSeeded } from "@/lib/seed";
import { NoticeList, type NoticeWithGame } from "@/components/NoticeList";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Notices" };

export default function NoticesPage() {
  ensureSeeded();
  const games = new Map(listNights().map((n) => [n.id, { title: n.title, date: n.date }]));
  const notices: NoticeWithGame[] = listNotices().map((n) => ({ ...n, game: n.nightId ? games.get(n.nightId) ?? null : null }));
  const unread = notices.filter((n) => n.readAt === null).length;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Notices for officers"
        subtitle={
          notices.length
            ? `${unread} unread. A notice means two numbers that should agree do not. It is a prompt to compare records, not a finding about anyone.`
            : undefined
        }
      />
      {notices.length ? (
        <NoticeList notices={notices} />
      ) : (
        <div className="rounded-xl border border-dashed border-line bg-card p-8 text-center">
          <p className="text-lg font-semibold text-ink">No notices</p>
          <p className="mt-1 text-sm text-ink-soft">
            When a cash count or a bank deposit is different from what was expected, a notice appears here for the officers.
          </p>
        </div>
      )}
    </div>
  );
}
