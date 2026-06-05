import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig = {
  transpilePackages: ['@goto-lab/pufu-editor'],
  turbopack: {
    root: path.resolve(__dirname, '../..'),
  },
} satisfies NextConfig;

export default nextConfig;
