import type { NextConfig } from "next";

// The browser talks to exactly two origins: the app itself and the Supabase Auth
// origin (src/lib/supabase/client.ts). Box, Ignatious, Resend, Microsoft Graph
// and Gmail are all server-side, so none of them appears here. Anything else a
// page tries to load (a remote image in model output or inbound mail, a
// tracking pixel, a framed page) is blocked. See docs/04-operations/csp-runbook.md
// for the host inventory and the rollback.
//
// This is an egress policy for content that cannot run script, not an XSS
// defense: script-src keeps 'unsafe-inline' (no nonce), and injected script can
// leave by navigation, which no CSP blocks.
function supabaseOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function contentSecurityPolicy(): string {
  const supabase = supabaseOrigin();
  const scriptSrc =
    process.env.NODE_ENV === "development"
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline'";
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self'${supabase ? ` ${supabase}` : ""}`,
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// Rollback switch: a build with CSP_REPORT_ONLY=1 sends the same policy as
// Content-Security-Policy-Report-Only, which blocks nothing. The choice is made
// when this file is evaluated at build, so changing the variable does nothing
// until the next build.
const cspHeaderName =
  process.env.CSP_REPORT_ONLY === "1"
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: cspHeaderName, value: contentSecurityPolicy() },
];

const nextConfig: NextConfig = {
  // DEV-ONLY. Next.js 16 blocks cross-origin requests to dev resources
  // (the client bundle / HMR) by default. When the dev server is reached
  // via the LAN "Network" URL instead of localhost, that block prevents
  // hydration and the app freezes on its first server paint. Allowing the
  // local network origins here lets the demo be presented from another
  // device on the same network (or shared via the Network URL).
  //
  // This has NO effect on the production build or Vercel — it only relaxes
  // a `next dev` safety default. Add additional IPs/hosts as needed.
  // Explicit host entries (no CIDR). Add another device's LAN IP here if
  // you present the demo from it.
  allowedDevOrigins: ["localhost", "127.0.0.1", "192.168.0.42"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
