import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "./globals.css";
import { HighlightApiStyles } from "@/components/mail/HighlightApiStyles";
import { SessionProvider } from "../lib/session/store";

/**
 * Type stack (Editorial Institutional — design spec §2).
 * Self-hosted via next/font/google, zero license cost, display:swap,
 * latin subset, size-adjusted fallback metrics (zero-CLS).
 *
 * - Serif display comes from the palette (--font-display; Workbench = Georgia).
 * - Inter → --font-bank (the interface face; system-first stack).
 * - Geist Mono → --font-mono (compliance output, rule IDs, tabular figures).
 */
// reference-faithful UI face (2026-07-09). the reference interface is Inter throughout;
// this is the primary sans (--font-bank) for the whole app.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Conductia",
  description:
    "The compliance-first M&A intelligence layer for managing directors.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-palette="workbench"
      data-style-mode="light"
      className={`${inter.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body suppressHydrationWarning className="h-full overflow-hidden">
        {/*
         * Root layout holds only global providers. The AI-native shell
         * (AppShell) is mounted by the (authed) route group so auth pages and
         * dev tools render outside it. Authentication is enforced in
         * middleware.ts.
         */}
        <HighlightApiStyles />
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
