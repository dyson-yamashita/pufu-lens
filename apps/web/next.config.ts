import path from 'node:path';
import type { NextConfig } from 'next';

const allowedDevOrigins = (process.env.PUFU_LENS_ALLOWED_DEV_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const shortUuidCompatPath = path.resolve(__dirname, 'src/vendor/short-uuid-compat.cjs');

const nextConfig = {
  allowedDevOrigins,
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
