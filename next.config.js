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

    outputFileTracingIncludes: {
      "/api/report-cron": [
        "./node_modules/@sparticuz/chromium/bin/**/*",
      ],
    },
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
