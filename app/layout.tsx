import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { canonicalOrigin } from "@/server/canonical-origin";
import "./globals.css";
export const metadata: Metadata = {
  title: "Voice Workbench · A space to think",
  description:
    "A personal workspace for your voice, clear writing, and the next good idea.",
  robots: { index: false, follow: false },
};
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const canonical = canonicalOrigin(
    (await headers()).get("host"),
    process.env.APP_ORIGIN,
  );
  if (canonical) redirect(canonical);
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
