import type { NextConfig } from 'next';

/**
 * The browser only ever talks to this origin. /api/core/* is proxied to
 * core-api, so there is no CORS surface and the API URL is a server-side
 * setting (CORE_API_URL), not something baked into client bundles.
 */
const coreApi = (process.env['CORE_API_URL'] ?? 'http://localhost:3001').replace(/\/+$/, '');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  agentRules: false,
  typedRoutes: true,
  experimental: {
    // A scaled-to-zero core-api can take ~60s to answer its first request.
    proxyTimeout: 90_000,
  },
  async rewrites() {
    return [
      { source: '/api/core/:path*', destination: `${coreApi}/:path*` },
      { source: '/auth/:path*', destination: `${coreApi}/auth/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'x-content-type-options', value: 'nosniff' },
          { key: 'referrer-policy', value: 'strict-origin-when-cross-origin' },
          { key: 'x-frame-options', value: 'SAMEORIGIN' },
          { key: 'permissions-policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
          { key: 'x-dns-prefetch-control', value: 'off' },
          {
            key: 'content-security-policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' blob: data:",
              "font-src 'self'",
              "connect-src 'self'",
              "frame-src 'self'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default config;
