"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Grouped the way the product is organised rather than the order pages were
// built. Only pages that exist are listed — a link to nothing would be a promise
// the desk cannot keep yet.
const GROUPS = [
  {
    label: "Command",
    links: [
      { href: "/", label: "Command Center" },
      { href: "/ask", label: "Capital Copilot" },
    ],
  },
  {
    label: "Discover",
    links: [
      { href: "/scanner", label: "Opportunity Scanner" },
      { href: "/watchlist", label: "Watchlist" },
      { href: "/scores", label: "Scores" },
    ],
  },
  {
    label: "Markets",
    links: [{ href: "/markets", label: "Market Overview" }],
  },
  {
    label: "AI",
    links: [
      { href: "/committee", label: "Investment Committee" },
      { href: "/ai", label: "Models & Performance" },
    ],
  },
  {
    label: "Portfolio",
    links: [
      { href: "/profile", label: "Investor Profile" },
      { href: "/transactions", label: "Ledger" },
      { href: "/risk", label: "Risk & Scenarios" },
    ],
  },
  {
    label: "Strategies",
    links: [
      { href: "/strategies", label: "Backtesting Lab" },
      { href: "/paper", label: "Paper Trading" },
    ],
  },
  {
    label: "Intelligence",
    links: [
      { href: "/alerts", label: "Alerts & Autopilot" },
      { href: "/journal", label: "Journal & Memory" },
    ],
  },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="sidebar" aria-label="Sections">
      {GROUPS.map((group) => (
        <div key={group.label} className="side-group">
          <span className="side-label">{group.label}</span>
          {group.links.map(({ href, label }) => {
            const current = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link key={href} href={href} aria-current={current ? "page" : undefined}>
                {label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
