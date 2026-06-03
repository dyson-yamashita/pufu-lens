import path from "node:path";
import type { NextConfig } from "next";

const nextConfig = {
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
} satisfies NextConfig;

export default nextConfig;
