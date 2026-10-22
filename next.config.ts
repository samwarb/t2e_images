import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  basePath: "/t2e_images",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
