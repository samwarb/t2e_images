import type { NextConfig } from "next";
const config: NextConfig = { output: "standalone", serverExternalPackages: ["@google-cloud/storage", "@google-cloud/firestore"] };
export default config;
