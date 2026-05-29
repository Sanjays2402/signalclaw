import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "SignalClaw",
  description: "Personal stock + crypto signal bot. NOT FINANCIAL ADVICE.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-[var(--border)] px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-bold tracking-tight">SignalClaw</span>
            <span className="muted text-xs">v0.1 dark</span>
          </div>
          <nav className="flex gap-4 text-sm">
            <a href="/" className="hover:text-white">Today</a>
            <a href="/watchlist" className="hover:text-white">Watchlist</a>
            <a href="/backtest" className="hover:text-white">Backtest</a>
            <a href="/about" className="hover:text-white">About</a>
          </nav>
        </header>
        <main className="p-4">{children}</main>
        <footer className="border-t border-[var(--border)] px-4 py-3 text-xs muted">
          NOT FINANCIAL ADVICE. SignalClaw is a personal research tool. See FINANCIAL_DISCLAIMER.md.
        </footer>
      </body>
    </html>
  );
}
