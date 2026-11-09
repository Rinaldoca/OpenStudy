import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // LAN access is opt-in — set VITE_LAN=1 to expose the dev server on the network
    // (useful for phone testing on a trusted home WiFi). Off by default so dev never
    // leaks to untrusted networks.
    host: process.env.VITE_LAN === "1",
    port: 5173,
    // Accept tunneled requests (e.g. cloudflared Quick Tunnels) when VITE_TUNNEL=1.
    // Still bound to localhost; only the tunnel daemon reaches Vite.
    // VITE_TAILSCALE=1: accept `tailscale serve` traffic (tailnet-only HTTPS).
    allowedHosts: [
      ...(process.env.VITE_TUNNEL === "1" ? [".trycloudflare.com", ".cfargotunnel.com"] : []),
      ...(process.env.VITE_TAILSCALE === "1" ? [".ts.net"] : []),
    ],
    proxy: {
      "/api": { target: "http://localhost:8000", changeOrigin: true },
      "/oauth": { target: "http://localhost:8000", changeOrigin: true },
      "/mcp": { target: "http://localhost:8000", changeOrigin: true },
      // Only proxy oauth-* well-known endpoints to the backend (FastAPI OAuth
      // metadata). Other /.well-known/* paths (e.g. security.txt) stay as
      // static files served from web/public/.well-known/.
      "^/\\.well-known/oauth-": { target: "http://localhost:8000", changeOrigin: true },
    },
  },
});
