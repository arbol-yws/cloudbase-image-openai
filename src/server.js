'use strict';

const { loadConfig } = require('./config');
const { createCloudbaseClient } = require('./cloudbase');
const { createApp } = require('./app');

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[startup] ${err.message}`);
    process.exit(1);
  }

  let client;
  try {
    client = createCloudbaseClient(config);
  } catch (err) {
    console.error(`[startup] Failed to initialize CloudBase SDK: ${err.message}`);
    process.exit(1);
  }

  const app = createApp({ config, client });
  const server = app.listen(config.port, () => {
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'server_started',
        port: config.port,
        default_model: config.defaultModel,
        auth_required: Boolean(config.adapterApiKey),
      }),
    );
  });

  // Node's default requestTimeout is 5 minutes, while CloudBase image generation
  // can take up to 15 minutes. n > 1 is split into several concurrency-limited
  // waves, so keep the HTTP request alive for the worst-case upstream budget.
  const waves = Math.ceil(config.maxN / config.maxConcurrency);
  server.requestTimeout =
    config.upstreamTimeoutMs * waves + config.b64DownloadTimeoutMs + 30000;

  const shutdown = (signal) => {
    console.log(JSON.stringify({ level: 'info', msg: 'server_stopping', signal }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
