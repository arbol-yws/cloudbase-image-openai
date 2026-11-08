'use strict';

const crypto = require('crypto');
const express = require('express');
const { ApiError, redactSecrets } = require('./errors');
const { createCloudbaseClient } = require('./cloudbase');
const { buildGenerationPlan } = require('./request');
const { buildOpenAIResponse } = require('./response');
const { runWithContext } = require('./upstream-capture');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * Only `Authorization: Bearer <key>` is accepted; CloudBase treats the key as
 * a bearer credential. Query strings and bodies are intentionally ignored.
 */
function extractBearerToken(req) {
  const header = (req.get('authorization') || '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : '';
}

/**
 * The caller's Authorization value is the CloudBase API Key for that request.
 * Server-side credentials, when configured, are only a fallback.
 */
function resolveCredentials(req, config) {
  const accessKey = extractBearerToken(req);
  if (accessKey) return { accessKey };
  if (config.apiKey) return { accessKey: config.apiKey };
  if (config.secretId && config.secretKey) {
    return { secretId: config.secretId, secretKey: config.secretKey };
  }
  return null;
}

function createApp({ config, logger = console }) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    req.requestId = req.get('x-request-id') || crypto.randomUUID();
    res.setHeader('x-request-id', req.requestId);
    res.setHeader('cache-control', 'no-store');
    const startedAt = Date.now();

    res.on('finish', () => {
      logger.info(
        JSON.stringify({
          level: 'info',
          msg: 'http_request',
          request_id: req.requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration_ms: Date.now() - startedAt,
        }),
      );
    });
    // Keep the request id visible to process-level handlers and to any
    // asynchronous work started from this request.
    runWithContext({ requestId: req.requestId }, () => next());
  });

  app.use(express.json({ limit: config.maxBodySize }));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.post(
    '/v1/images/generations',
    asyncHandler(async (req, res) => {
      const credentials = resolveCredentials(req, config);
      if (!credentials) {
        throw new ApiError(
          401,
          'CloudBase credentials are missing or malformed. Use exactly "Authorization: Bearer <CloudBase API Key>" with a server API Key for this environment, or configure a fallback key on the server.',
          { code: 'missing_credentials', type: 'authentication_error' },
        );
      }

      if (req.is('multipart/form-data')) {
        throw new ApiError(
          400,
          'Only application/json is supported. Send reference images as public URLs, data URLs, or raw base64 strings in "image" or "image[]".',
          { code: 'unsupported_content_type' },
        );
      }
      if (!req.is('application/json')) {
        throw new ApiError(415, 'Content-Type must be application/json.', {
          code: 'unsupported_media_type',
        });
      }

      const plan = buildGenerationPlan(req.body, config);
      const client = createCloudbaseClient(config, credentials);
      const results = await client.generateImages(plan);
      const response = await buildOpenAIResponse(results, plan, config);

      res.status(200).json(response);
    }),
  );

  app.use((req, res) => {
    res
      .status(404)
      .json(new ApiError(404, `Route ${req.method} ${req.path} was not found.`, { code: 'not_found' }).toJSON());
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) {
      // Never leak a stack through Express' default handler.
      logger.error(
        JSON.stringify({
          level: 'error',
          msg: 'response_already_sent_error',
          request_id: req.requestId,
          error: redactSecrets(err?.message || String(err)),
          stack: redactSecrets(err?.stack || ''),
        }),
      );
      res.end();
      return;
    }

    let apiError;
    if (err instanceof ApiError) {
      apiError = err;
    } else if (err?.type === 'entity.too.large') {
      apiError = new ApiError(413, `Request body exceeds the configured limit (${config.maxBodySize}).`, {
        code: 'request_too_large',
      });
    } else if (err instanceof SyntaxError && (err.status === 400 || err.type === 'entity.parse.failed')) {
      apiError = new ApiError(400, 'Request body is not valid JSON.', { code: 'invalid_json' });
    } else {
      // Any non-ApiError means an unexpected, synchronous or asynchronous
      // failure. Log the full stack (redacted) plus the request id, but never
      // expose it to the caller.
      logger.error(
        JSON.stringify({
          level: 'error',
          msg: 'unhandled_error',
          request_id: req.requestId,
          error: redactSecrets(err?.message || String(err)),
          stack: redactSecrets(err?.stack || ''),
        }),
      );
      apiError = new ApiError(500, 'Internal server error.', { code: 'internal_error' });
    }

    if (apiError.upstream) {
      // Log upstream diagnostics for 4xx as well, so a 400 never reaches the
      // caller without a corresponding server-side record.
      logger.error(
        JSON.stringify({
          level: 'error',
          msg: 'upstream_error',
          request_id: req.requestId,
          status: apiError.statusCode,
          code: apiError.code,
          upstream: apiError.upstream,
        }),
      );
    }

    if (apiError.statusCode >= 500) {
      logger.error(
        JSON.stringify({
          level: 'error',
          msg: 'request_failed',
          request_id: req.requestId,
          status: apiError.statusCode,
          code: apiError.code,
          error: redactSecrets(apiError.message),
        }),
      );
    }

    res.status(apiError.statusCode).json(apiError.toJSON());
  });

  return app;
}

module.exports = { createApp, resolveCredentials, extractBearerToken };
