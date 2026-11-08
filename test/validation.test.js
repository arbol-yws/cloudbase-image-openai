'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../src/config');
const { buildGenerationPlan } = require('../src/request');
const { buildModelMap } = require('../src/models');
const { ApiError, mapUpstreamError } = require('../src/errors');

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function planConfig(overrides = {}) {
  return {
    defaultModel: 'hy-image-v3.5-preview',
    modelMap: buildModelMap(),
    maxN: 10,
    revisePrompt: true,
    ...overrides,
  };
}

function isApiError(statusCode, code) {
  return (err) => err instanceof ApiError && err.statusCode === statusCode && err.code === code;
}

test('defaults to the current CloudBase model', () => {
  const plan = buildGenerationPlan({ prompt: '一只猫' }, planConfig());
  assert.equal(plan.model, 'hy-image-v3.5-preview');
  assert.equal(plan.n, 1);
  assert.equal(plan.responseFormat, 'url');
  assert.deepEqual(plan.images, []);
});

test('maps OpenAI aliases and accepts a URL reference image', () => {
  const plan = buildGenerationPlan(
    {
      model: 'gpt-image-1',
      prompt: '参考这张图',
      image: 'https://example.com/reference.png',
      size: '1024x1024',
    },
    planConfig(),
  );
  assert.equal(plan.model, 'hy-image-v3.5-preview');
  assert.equal(plan.images.length, 1);
  assert.equal(plan.images[0].kind, 'url');
  assert.equal(plan.size, '1024x1024');
});

test('legacy I2I model requires a reference image', () => {
  assert.throws(
    () => buildGenerationPlan({ model: 'cloudbase-i2i', prompt: '油画风格' }, planConfig()),
    isApiError(400, 'missing_reference_image'),
  );
});

test('legacy I2I model rejects more than one reference image', () => {
  assert.throws(
    () =>
      buildGenerationPlan(
        {
          model: 'cloudbase-i2i',
          prompt: '油画风格',
          image: ['https://example.com/a.png', 'https://example.com/b.png'],
        },
        planConfig(),
      ),
    isApiError(400, 'too_many_images'),
  );
});

test('legacy I2I model rejects OpenAI size 1792x1024', () => {
  assert.throws(
    () =>
      buildGenerationPlan(
        {
          model: 'cloudbase-i2i',
          prompt: '油画风格',
          image: 'https://example.com/reference.png',
          size: '1792x1024',
        },
        planConfig(),
      ),
    isApiError(400, 'unsupported_size'),
  );
});

test('current model accepts 4096x4096', () => {
  const plan = buildGenerationPlan(
    { model: 'hy-image-v3.5-preview', prompt: '海报', size: '4096x4096' },
    planConfig(),
  );
  assert.equal(plan.size, '4096x4096');
});

test('rejects unsupported OpenAI capability fields instead of ignoring them', () => {
  assert.throws(
    () => buildGenerationPlan({ prompt: '一只猫', quality: 'high' }, planConfig()),
    isApiError(400, 'unsupported_parameter'),
  );
});

test('accepts raw base64 reference images and detects PNG', () => {
  const plan = buildGenerationPlan(
    { model: 'hy-image-v3.5-preview', prompt: '参考这只猫', image: TINY_PNG_BASE64 },
    planConfig(),
  );
  assert.equal(plan.images.length, 1);
  assert.equal(plan.images[0].kind, 'base64');
  assert.equal(plan.images[0].mime, 'image/png');
  assert.match(plan.images[0].dataUrl, /^data:image\/png;base64,/);
});

test('legacy I2I model rejects WebP reference images', () => {
  assert.throws(
    () =>
      buildGenerationPlan(
        {
          model: 'cloudbase-i2i',
          prompt: '油画风格',
          image: 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=',
        },
        planConfig(),
      ),
    isApiError(400, 'unsupported_image_type'),
  );
});

test('maps upstream authentication failures to 502', () => {
  const error = new Error('Request failed with status code 401');
  error.code = '401';
  const mapped = mapUpstreamError(error);
  assert.equal(mapped.statusCode, 502);
  assert.equal(mapped.code, 'upstream_authentication_error');
});

test('maps upstream timeouts to 504', () => {
  const error = new Error('timeout of 900000ms exceeded');
  error.code = 'ETIMEDOUT';
  const mapped = mapUpstreamError(error);
  assert.equal(mapped.statusCode, 504);
  assert.equal(mapped.code, 'upstream_timeout');
});

test('maps upstream rate limits to 429', () => {
  const error = new Error('Request failed with status code 429');
  error.code = '429';
  const mapped = mapUpstreamError(error);
  assert.equal(mapped.statusCode, 429);
  assert.equal(mapped.code, 'rate_limit_exceeded');
});

test('maps upstream content moderation (422) to an OpenAI-style 400', () => {
  const error = new Error('Request failed with status code 422');
  error.code = '422';
  const mapped = mapUpstreamError(error);
  assert.equal(mapped.statusCode, 400);
  assert.equal(mapped.code, 'moderation_blocked');
});

test('startup fails when CloudBase credentials are missing', () => {
  assert.throws(() => loadConfig({}), /CLOUDBASE_ENV_ID/);
  assert.throws(() => loadConfig({ CLOUDBASE_ENV_ID: 'env-id' }), /credentials are missing/i);
});

test('loads a valid configuration with an API key', () => {
  const config = loadConfig({
    CLOUDBASE_ENV_ID: 'env-id',
    CLOUDBASE_APIKEY: 'api-key',
    DEFAULT_MODEL: 'gpt-image-1',
  });
  assert.equal(config.defaultModel, 'hy-image-v3.5-preview');
  assert.equal(config.maxN, 10);
});

test('rejects an invalid DEFAULT_MODEL', () => {
  assert.throws(
    () =>
      loadConfig({
        CLOUDBASE_ENV_ID: 'env-id',
        CLOUDBASE_APIKEY: 'api-key',
        DEFAULT_MODEL: 'not-a-model',
      }),
    /not a supported CloudBase model/,
  );
});
