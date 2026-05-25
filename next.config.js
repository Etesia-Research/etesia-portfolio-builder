/** @type {import('next').NextConfig} */
// Browser-side fallback so @stellar/stellar-sdk (which references Node core
// modules) bundles cleanly on the client. Reused from a prior Stellar app.
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

module.exports = nextConfig;
