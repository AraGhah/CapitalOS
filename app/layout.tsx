import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CapitalOS",
  description: "Personal portfolio ledger and research desk",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <nav className="topnav">
          <Link href="/">Dashboard</Link>
          <Link href="/transactions">Transactions</Link>
          <Link href="/scores">Scores</Link>
        </nav>
        <main className="page">{children}</main>
      </body>
    </html>
  );
}
