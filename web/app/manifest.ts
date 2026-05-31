import type { MetadataRoute } from "next";

/**
 * PWA manifest. Lets users "Install" SignalClaw on phone (Add to Home Screen)
 * or desktop (Chrome/Edge install button). Pairs with components/InstallPrompt
 * and public/sw.js (offline shell).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SignalClaw Terminal",
    short_name: "SignalClaw",
    description:
      "Quant signal terminal. Regime classifier, backtests, alerts. Personal research tool, not financial advice.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    categories: ["finance", "productivity", "utilities"],
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
