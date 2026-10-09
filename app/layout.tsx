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
import { SignOut } from "./components/SignOut";
import { currentUser } from "@/lib/auth/current";
import { config } from "@/lib/config";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

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

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // The sign-in page renders without the desk's chrome: nothing about the
  // desk is shown to someone who has not signed in.
  const user = await currentUser().catch(() => null);
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  if (!user) {
    // A cookie can be well signed and still expired or revoked: anything but
    // the sign-in page goes back to it.
    const path = (await headers()).get("x-pathname") ?? "/";
    if (path !== "/login") redirect("/login");
    return (
      <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
        <head>
          <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        </head>
        <body>
          <main className="page auth-page">{children}</main>
        </body>
      </html>
    );
  }

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeBootScript }} />
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
          <div className="topbar-right">
            <TickerSearch />
            <ThemeToggle />
            {!config().AUTH_DISABLED && <SignOut email={user.email} />}
          </div>
        </header>

        <Suspense fallback={null}>
          <TickerTape actor={{ userId: user.userId, accountId: user.accountId }} />
        </Suspense>

        <div className="shell">
          <Nav />
          <main className="page">{children}</main>
        </div>
      </body>
    </html>
  );
}
