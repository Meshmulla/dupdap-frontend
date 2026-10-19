/** @type {import('next').NextConfig} */
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api/v1';

// Known Stellar / wallet origins that the app must be able to reach from the
// browser. Horizon (testnet + mainnet) for balance/tx submission, Soroban RPC
// for contract calls, and the Freighter / Stellar Wallets Kit endpoints used
// during wallet connection and signing.
const STELLAR_ORIGINS = [
  'https://horizon-testnet.stellar.org',
  'https://horizon.stellar.org',
  'https://soroban-testnet.stellar.org',
  'https://soroban.stellar.org',
  'https://friendbot.stellar.org',
  'https://api.freighter.app',
];

const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: apiUrl,
  },
  async headers() {
    const connectSrc = ["'self'", new URL(apiUrl).origin, ...STELLAR_ORIGINS];

    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // script-src is set per-request in middleware.ts with a nonce so
              // inline scripts (e.g. JSON-LD) can run without 'unsafe-inline'
              // or 'unsafe-eval'. This static header is a fallback for routes
              // that bypass middleware; it intentionally omits both directives.
              "script-src 'self'",
              "style-src 'self' 'unsafe-inline'",
              `connect-src ${connectSrc.join(' ')}`,
              "img-src 'self' data: blob:",
              "font-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
        ],
      },
    ];
  },
  images: {
    // No next/image usage yet, but remote imagery (merchant logos, avatars,
    // marketing assets) is expected eventually. Add each external host here
    // via remotePatterns as it's introduced — next/image throws at
    // build/runtime for any domain not explicitly allow-listed.
    //
    // Example:
    // remotePatterns: [
    //   {
    //     protocol: 'https',
    //     hostname: 'cdn.example.com',
    //     pathname: '/**',
    //   },
    // ],
    remotePatterns: [],
  },
};

module.exports = nextConfig;
