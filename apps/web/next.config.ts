import path from 'node:path';
import type { NextConfig } from 'next';

const allowedDevOrigins = (process.env.PUFU_LENS_ALLOWED_DEV_ORIGINS ?? '192.168.10.119')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig = {
  allowedDevOrigins,
  transpilePackages: ['@goto-lab/pufu-editor'],
  turbopack: {
    root: path.resolve(__dirname, '../..'),
  },
} satisfies NextConfig;

export default nextConfig;
