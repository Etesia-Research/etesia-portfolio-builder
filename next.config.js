const { PHASE_DEVELOPMENT_SERVER } = require("next/constants");

/** @type {import('next').NextConfig} */
// Browser-side fallback so @stellar/stellar-sdk (which references Node core
// modules) bundles cleanly on the client.
const nextConfig = {
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        tls: false,
        net: false,
        dgram: false,
        dns: false,
      };
    }
    return config;
  },
};

// Keep production builds from replacing files used by a running dev server.
module.exports = (phase) => ({
  ...nextConfig,
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
});
