'use strict';

const crypto = require('crypto');
const express = require('express');
const { ApiError } = require('./errors');
const { buildGenerationPlan } = require('./request');
const { buildOpenAIResponse } = require('./response');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireAuth(req, config) {
  if (!config.adapterApiKey) return;

  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    throw new ApiError(401, 'Missing bearer token. Set Authorization: Bearer <ADAPTER_API_KEY>.', {
      code: 'missing_api_key',
    });
  }
  if (!safeEqual(match[1], config.adapterApiKey)) {
    throw new ApiError(401, 'Invalid bearer token.', { code: 'invalid_api_key' });
  }
}

function createApp({ config, client, logger = console }) {
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
    next();
  });

  app.use(express.json({ limit: config.maxBodySize }));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.post(
    '/v1/images/generations',
    asyncHandler(async (req, res) => {
      requireAuth(req, config);

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
      next(err);
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
      logger.error(
        JSON.stringify({
          level: 'error',
          msg: 'unhandled_error',
          request_id: req.requestId,
          error: err?.message || String(err),
        }),
      );
      apiError = new ApiError(500, 'Internal server error.', { code: 'internal_error' });
    }

    if (apiError.statusCode >= 500) {
      logger.error(
        JSON.stringify({
          level: 'error',
          msg: 'request_failed',
          request_id: req.requestId,
          status: apiError.statusCode,
          code: apiError.code,
          error: apiError.message,
        }),
      );
    }

    res.status(apiError.statusCode).json(apiError.toJSON());
  });

  return app;
}

module.exports = { createApp, requireAuth, safeEqual };
