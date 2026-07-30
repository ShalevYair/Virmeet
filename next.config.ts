import type { NextConfig } from "next";

// @anthropic-ai/sdk and @google/genai statically import a handful of Node
// builtins (fs, path, stream, ...) for code paths we never exercise in the
// browser (OAuth credential files, Node-stream multipart uploads — we only
// ever pass an explicit apiKey and plain JSON). Webpack's client bundle
// target doesn't resolve the "node:" URI scheme at all by default, so the
// build fails before it can even tree-shake that code away. Strip the
// "node:" prefix and stub the bare builtins out for the client bundle.
const NODE_BUILTINS_USED_SERVER_SIDE_ONLY = [
  "fs",
  "fs/promises",
  "path",
  "crypto",
  "stream",
  "stream/promises",
  "stream/web",
  "readline",
  "util",
  "os",
];

const nextConfig: NextConfig = {
  output: "export",
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
  images: { unoptimized: true },
  trailingSlash: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  webpack(config, { isServer, webpack }) {
    if (!isServer) {
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource: { request: string }) => {
          resource.request = resource.request.replace(/^node:/, "");
        })
      );
      config.resolve.fallback = {
        ...config.resolve.fallback,
        ...Object.fromEntries(NODE_BUILTINS_USED_SERVER_SIDE_ONLY.map((name) => [name, false])),
      };
    }
    return config;
  },
};

export default nextConfig;
