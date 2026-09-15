import type { Metadata } from "next";
import { headers } from "next/headers";
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
  await headers();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
