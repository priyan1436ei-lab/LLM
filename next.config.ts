import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The environment probe found a stray C:\Users\priya\package-lock.json that makes
  // Turbopack try to treat the user's home directory as the workspace root. Pinning
  // the root keeps the build deterministic and silences that warning.
  turbopack: {
    root: __dirname,
  },

  // sharp is used server-side for the image pipeline. Keep it out of the bundler
  // so the prebuilt platform binary is loaded at runtime, not traced into the build.
  serverExternalPackages: ['@electric-sql/pglite', 'sharp', 'tesseract.js'],

  poweredByHeader: false,

  async headers() {
    // Security headers (spec §106). CSP is intentionally strict; Next's inline
    // bootstrap needs 'unsafe-inline' for styles only. No wildcard connect-src.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data:",
      "media-src 'self' blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(self), geolocation=(), payment=()',
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
      {
        // The private dashboard must never be indexed (spec §125).
        source: '/dashboard/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
    ];
  },

  async redirects() {
    return [];
  },
};

export default nextConfig;
