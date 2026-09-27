import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import "./globals.css";
import { Nav } from "./components/Nav";
import { TickerSearch } from "./components/TickerSearch";
import { ThemeToggle, themeBootScript } from "./components/ThemeToggle";
import { TickerTape } from "./components/TickerTape";
import { DeskStatus } from "./components/DeskStatus";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Capital OS",
  description: "A personal investment desk: ledger, scores, filings and the news wire behind them.",
};

// The chrome reads the database on every request, so nothing here is prerendered.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            <span className="mark">C</span>
            Capital OS
          </Link>
          <Suspense fallback={null}>
            <DeskStatus />
          </Suspense>
          <Nav />
          <div className="topbar-right">
            <TickerSearch />
            <ThemeToggle />
          </div>
        </header>

        <Suspense fallback={null}>
          <TickerTape />
        </Suspense>

        <main className="page">{children}</main>
      </body>
    </html>
  );
}
