/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  webpack: (config, { isServer, nextRuntime }) => {
    if (isServer && nextRuntime === 'nodejs') {
      config.externals.push(
        'node-libcurl',
        'fast-flights-ts',
        '@langchain/langgraph',
        '@langchain/core',
        '@langchain/core/messages',
        // The Postgres checkpointer opens a TCP pool via `pg`, which must not
        // be bundled into the serverless function.
        '@langchain/langgraph-checkpoint-postgres',
        'pg'
      );
    }
    return config;
  },
  async headers() {
    return [
      {
        source: '/',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-store, no-cache, must-revalidate, max-age=0',
          },
        ],
      },
    ]
  },
}

module.exports = nextConfig
