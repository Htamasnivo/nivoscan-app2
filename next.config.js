/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },

  eslint: {
    ignoreDuringBuilds: true,
  },

  experimental: {
    serverComponentsExternalPackages: [
      "playwright-core",
      "@sparticuz/chromium",
    ],
  },

  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals || [];

      config.externals.push({
        "playwright-core": "commonjs playwright-core",
        "@sparticuz/chromium": "commonjs @sparticuz/chromium",
      });
    }

    return config;
  },
};

module.exports = nextConfig;
