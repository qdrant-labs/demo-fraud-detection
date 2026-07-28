import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev only: lets a phone on the LAN load the dev server for hero-moment
  // testing. Production (Vercel) ignores this.
  allowedDevOrigins: ["192.168.1.149"],
  // Old QR links pointed at /join; the launcher now lives in a drawer on the
  // wall itself, so everything lands on the root page.
  async redirects() {
    return [{ source: "/join", destination: "/", permanent: false }];
  },
};

export default nextConfig;
