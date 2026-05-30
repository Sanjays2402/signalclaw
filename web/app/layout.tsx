import "./globals.css";
import type { ReactNode } from "react";
import NavLink from "@/components/NavLink";
import CommandPalette from "@/components/CommandPalette";
import PaletteHint from "@/components/PaletteHint";

export const metadata = {
  title: "SignalClaw",
  description: "Personal stock + crypto signal bot. NOT FINANCIAL ADVICE.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-[var(--border)] px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <span className="font-bold tracking-tight">SignalClaw</span>
            <span className="muted text-xs">v0.2</span>
            <PaletteHint />
          </div>
          <nav className="flex flex-wrap gap-1 text-sm">
            <NavLink href="/">Today</NavLink>
            <NavLink href="/portfolio">Portfolio</NavLink>
            <NavLink href="/watchlist">Watchlist</NavLink>
            <NavLink href="/alerts">Alerts</NavLink>
            <NavLink href="/brackets">Brackets</NavLink>
            <NavLink href="/journal">Journal</NavLink>
            <NavLink href="/backtest">Backtest</NavLink>
            <NavLink href="/optimize">Optimize</NavLink>
            <NavLink href="/risk">Risk</NavLink>
            <NavLink href="/rotation">Rotation</NavLink>
            <NavLink href="/reports">Reports</NavLink>
            <NavLink href="/earnings">Earnings</NavLink>
            <NavLink href="/news">News</NavLink>
            <NavLink href="/stops">Stops</NavLink>
            <NavLink href="/correlation">Correlation</NavLink>
            <NavLink href="/diversification">Diversify</NavLink>
            <NavLink href="/ledger">Ledger</NavLink>
            <NavLink href="/tax">Tax</NavLink>
            <NavLink href="/scaling">Scaling</NavLink>
            <NavLink href="/fx">FX</NavLink>
            <NavLink href="/notifier">Notifier</NavLink>
            <NavLink href="/webhooks">Webhooks</NavLink>
            <NavLink href="/about">About</NavLink>
          </nav>
        </header>
        <main className="p-4 md:p-6">{children}</main>
        <CommandPalette />
        <footer className="border-t border-[var(--border)] px-4 py-3 text-xs muted">
          NOT FINANCIAL ADVICE. SignalClaw is a personal research tool. See FINANCIAL_DISCLAIMER.md.
        </footer>
      </body>
    </html>
  );
}
