import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// Every upstream (Binance REST, DefiLlama, Deribit, CoinGecko, RPC nodes) is
// fetched server-side, so the browser only ever talks to our own /api/*. The
// one exception is the Binance live WebSocket, which the price board, trade
// tape, order book and liquidation feed stream directly.
const BINANCE_WS = "wss://stream.binance.com wss://stream.binance.com:9443 wss://fstream.binance.com";

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${BINANCE_WS}`,
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // MUST be false: the edge proxy already gzips at the edge. Double compression
  // corrupts the stream and Cloudflare caches the truncated body.
  compress: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
