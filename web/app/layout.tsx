import "./globals.css";
import type { ReactNode } from "react";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import NavLink from "@/components/NavLink";
import CommandPalette from "@/components/CommandPalette";
import PaletteHint from "@/components/PaletteHint";
import TickerTape from "@/components/TickerTape";
import RegimeIndicator from "@/components/RegimeIndicator";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata = {
  title: "SignalClaw Terminal",
  description: "Quant signal terminal. Personal research tool. Not financial advice.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="min-h-screen">
        {/* Top regime bar */}
        <header className="border-b border-[var(--border-strong)] bg-[var(--bg-elev)] px-4 py-2 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <span className="font-bold tracking-tight text-[13px]" style={{ letterSpacing: "0.04em" }}>
              SIGNAL<span style={{ color: "var(--amber)" }}>CLAW</span>
            </span>
            <span className="mono text-[10px] muted">v0.2</span>
            <PaletteHint />
          </div>
          <div className="flex items-center gap-4">
            <RegimeIndicator />
            <span className="muted text-[10px] uppercase tracking-widest hidden md:inline">
              Research only. Not advice.
            </span>
          </div>
        </header>

        {/* Ticker tape */}
        <TickerTape />

        {/* Nav */}
        <nav className="border-b border-[var(--border)] bg-[var(--bg)] px-4 py-1.5 flex flex-wrap gap-0.5 text-[11px] uppercase tracking-wider">
          <NavLink href="/">Today</NavLink>
          <NavLink href="/portfolio">Portfolio</NavLink>
          <NavLink href="/watchlist">Watch</NavLink>
          <NavLink href="/alerts">Alerts</NavLink>
          <NavLink href="/brackets">Brackets</NavLink>
          <NavLink href="/journal">Journal</NavLink>
          <NavLink href="/backtest">Backtest</NavLink>
          <NavLink href="/optimize">Optimize</NavLink>
          <NavLink href="/risk">Risk</NavLink>
          <NavLink href="/regime">Regime</NavLink>
          <NavLink href="/execution">Exec</NavLink>
          <NavLink href="/rotation">Rotation</NavLink>
          <NavLink href="/reports">Reports</NavLink>
          <NavLink href="/earnings">Earnings</NavLink>
          <NavLink href="/news">News</NavLink>
          <NavLink href="/stops">Stops</NavLink>
          <NavLink href="/correlation">Corr</NavLink>
          <NavLink href="/diversification">Diversify</NavLink>
          <NavLink href="/ledger">Ledger</NavLink>
          <NavLink href="/tax">Tax</NavLink>
          <NavLink href="/scaling">Scaling</NavLink>
          <NavLink href="/fx">FX</NavLink>
          <NavLink href="/notifier">Notifier</NavLink>
          <NavLink href="/webhooks">Webhooks</NavLink>
          <NavLink href="/about">About</NavLink>
        </nav>

        <main className="p-4 md:p-5">{children}</main>
        <CommandPalette />
        <footer className="border-t border-[var(--border)] px-4 py-2 text-[10px] muted uppercase tracking-widest">
          Not financial advice. Personal research tool. Outputs may be wrong.
        </footer>
      </body>
    </html>
  );
}
