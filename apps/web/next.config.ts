import path from 'node:path';
import type { NextConfig } from 'next';

const allowedDevOrigins = (process.env.PUFU_LENS_ALLOWED_DEV_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const shortUuidCompatPath = path.resolve(__dirname, 'src/vendor/short-uuid-compat.cjs');

const nextConfig = {
  allowedDevOrigins,
  async headers() {
    return [
      {
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "base-uri 'self'; frame-ancestors 'none'; object-src 'none'",
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
        source: '/:path*',
      },
    ];
  },
  poweredByHeader: false,
  transpilePackages: ['@goto-lab/pufu-editor'],
  turbopack: {
    resolveAlias: {
      'short-uuid': './src/vendor/short-uuid-compat.cjs',
    },
    root: path.resolve(__dirname, '../..'),
  },
  webpack(config) {
    config.resolve ??= {};
    config.resolve.alias = {
      ...config.resolve.alias,
      'short-uuid': shortUuidCompatPath,
    };
    return config;
  },
} satisfies NextConfig;

export default nextConfig;
