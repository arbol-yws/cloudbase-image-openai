'use strict';

const { loadConfig } = require('./config');
const { createApp } = require('./app');
const { redactSecrets } = require('./errors');
const { getContext, getPatchState } = require('./upstream-capture');

function logFatal(msg, value) {
  const context = getContext();
  const error = value instanceof Error ? value : new Error(String(value ?? 'unknown'));
  console.error(
    JSON.stringify({
      level: 'error',
      msg,
      request_id: context?.requestId ?? null,
      error: redactSecrets(error.message),
      stack: redactSecrets(error.stack || ''),
    }),
  );
}

// Last-resort logging. Route errors are already handled by src/app.js and still
// return the OpenAI error shape; these handlers only cover failures outside the
// request pipeline, where a response can no longer be guaranteed.
process.on('uncaughtException', (err) => {
  logFatal('uncaught_exception', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logFatal('unhandled_rejection', reason);
});

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[startup] ${err.message}`);
    process.exit(1);
  }

  const app = createApp({ config });
  const server = app.listen(config.port, () => {
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'server_started',
        port: config.port,
        credentials_source: config.apiKey || (config.secretId && config.secretKey)
          ? 'caller_bearer_with_server_fallback'
          : 'caller_bearer',
        upstream_body_capture: getPatchState(),
      }),
    );
  });

  // Node's default requestTimeout is 5 minutes; CloudBase image generation can
  // take up to 15 minutes.
  server.requestTimeout =
    config.upstreamTimeoutMs + config.b64DownloadTimeoutMs + 30000;

  const shutdown = (signal) => {
    console.log(JSON.stringify({ level: 'info', msg: 'server_stopping', signal }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
