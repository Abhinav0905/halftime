import type { Metadata } from "next";
import { cookies } from "next/headers";
import { STAFF_COOKIE, hasStaffCookie, safeNextPath, staffPin } from "@/lib/staff";
import { Card, LinkButton, PageHeader } from "@/components/ui";
import { StaffSignIn, StaffSignOut } from "./StaffForms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Staff sign-in" };

export default async function StaffPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const next = safeNextPath(typeof query.next === "string" ? query.next : undefined);
  const pin = staffPin();
  const signedIn = pin !== null && (await hasStaffCookie((await cookies()).get(STAFF_COOKIE)?.value, pin));

  return (
    <div className="mx-auto max-w-md">
      <PageHeader title="Staff sign-in" subtitle="Volunteers and officers enter the club's staff PIN once on each device." />
      <Card>
        {pin === null ? (
          <div className="space-y-3">
            <p className="text-ink">This server has no staff PIN set, so every page is open.</p>
            <p className="text-sm text-muted">Set STAFF_PIN on the server before sharing its address with fans.</p>
            <LinkButton href={next}>Continue</LinkButton>
          </div>
        ) : signedIn ? (
          <div className="space-y-3">
            <p className="text-ink">This device is signed in as staff.</p>
            <div className="flex flex-wrap gap-2">
              <LinkButton href={next}>Continue</LinkButton>
              <StaffSignOut />
            </div>
          </div>
        ) : (
          <StaffSignIn next={next} />
        )}
      </Card>
      <p className="mt-4 text-sm text-muted">Paying at the booth? Scan the QR code at the stand instead. Fans don&apos;t need a PIN.</p>
    </div>
  );
}
