import { WifiSlash } from "@phosphor-icons/react/dist/ssr";

export const metadata = {
  title: "Offline — SignalClaw",
};

export default function OfflinePage() {
  return (
    <div className="max-w-md mx-auto mt-24 panel p-6 text-center">
      <div className="flex justify-center mb-4">
        <WifiSlash size={48} weight="duotone" style={{ color: "var(--amber)" }} />
      </div>
      <h1 className="text-base font-semibold mb-2 mono">You are offline</h1>
      <p className="muted text-[12px] leading-relaxed mb-5">
        SignalClaw needs a network connection to fetch fresh prices, regimes,
        and runs. Cached pages will keep working until you reconnect.
      </p>
      <a
        href="/"
        className="inline-block bg-[var(--amber)] text-black font-semibold rounded-sm px-4 py-2 text-[11px] uppercase tracking-widest"
      >
        Retry
      </a>
    </div>
  );
}
