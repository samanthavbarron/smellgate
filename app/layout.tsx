import type { Metadata } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/SiteHeader";
import { getSession } from "@/lib/auth/session";
import { getAccountHandle } from "@/lib/db/queries";
import { isCurator } from "@/lib/curators";

export const metadata: Metadata = {
  title: "smellgate",
  description: "A letterboxd-style app for perfume, built on ATProto",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Resolve the visitor's session once, at the layout level, and pass
  // the resulting summary down to the header. Per-page components that
  // need the session can still call `getSession()` themselves — it's a
  // cached restore — but the header is the one universal consumer so
  // it lives here.
  const session = await getSession();
  const handle = session ? await getAccountHandle(session.did) : null;
  const viewerIsCurator = session ? isCurator(session.did) : false;

  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-50 font-sans text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
        <SiteHeader
          signedIn={!!session}
          handle={handle}
          isCurator={viewerIsCurator}
        />
        <main className="mx-auto w-full max-w-5xl px-4 py-10">{children}</main>
      </body>
    </html>
  );
}
