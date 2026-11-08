'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../src/config');
const { buildGenerationPlan } = require('../src/request');
const { resolveProtocol } = require('../src/models');
const { resolveCredentials } = require('../src/app');
const { ApiError, mapUpstreamError, redactSecrets } = require('../src/errors');

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function planConfig(overrides = {}) {
  return { maxN: 10, revisePrompt: true, ...overrides };
}

function request(overrides = {}) {
  return { headers: {}, get(name) { return this.headers[name.toLowerCase()] || ''; }, ...overrides };
}

function isApiError(statusCode, code) {
  return (err) => err instanceof ApiError && err.statusCode === statusCode && err.code === code;
}

test('requires the caller to specify a model', () => {
  assert.throws(
    () => buildGenerationPlan({ prompt: '一只猫' }, planConfig()),
    isApiError(400, 'model_required'),
  );
});

test('forwards the model identifier verbatim without a whitelist', () => {
  const plan = buildGenerationPlan(
    { model: 'some-future-cloudbase-model', prompt: '一只猫' },
    planConfig(),
  );
  assert.equal(plan.model, 'some-future-cloudbase-model');
  assert.equal(plan.protocol, 'legacy');
});

test('dispatches hy-image-* models to the messages protocol', () => {
  const plan = buildGenerationPlan(
    {
      model: 'hy-image-v3.5-preview',
      prompt: '参考这张图',
      image: ['https://example.com/a.png', 'https://example.com/b.png'],
      size: '1536x1024',
    },
    planConfig(),
  );
  assert.equal(plan.protocol, 'messages');
  assert.equal(plan.spec.provider, 'cloudbase');
  assert.equal(plan.images.length, 2);
  assert.equal(plan.size, '1536x1024');
  assert.equal(plan.revise, undefined);
});

test('dispatches other models to the legacy protocol', () => {
  assert.equal(resolveProtocol('HY-Image-v3.0-I2I-ToB-v1.0.1'), 'legacy');
  assert.equal(resolveProtocol('HY-Image-3.0-Plus-4090-Tob-v1.0'), 'legacy');
});

test('legacy protocol accepts at most one reference image', () => {
  assert.throws(
    () =>
      buildGenerationPlan(
        {
          model: 'HY-Image-v3.0-I2I-ToB-v1.0.1',
          prompt: '油画风格',
          image: ['https://example.com/a.png', 'https://example.com/b.png'],
        },
        planConfig(),
      ),
    isApiError(400, 'too_many_images'),
  );
});

test('passes non-standard sizes through instead of enforcing a whitelist', () => {
  const plan = buildGenerationPlan(
    { model: 'HY-Image-v3.0-I2I-ToB-v1.0.1', prompt: '油画风格', size: '1792x1024' },
    planConfig(),
  );
  assert.equal(plan.size, '1792x1024');
});

test('does not enforce prompt length locally', () => {
  const longPrompt = '猫'.repeat(600);
  const plan = buildGenerationPlan(
    { model: 'HY-Image-3.0-Plus-4090-Tob-v1.0', prompt: longPrompt },
    planConfig(),
  );
  assert.equal(plan.prompt.length, 600);
});

test('rejects unsupported OpenAI capability fields instead of ignoring them', () => {
  assert.throws(
    () => buildGenerationPlan({ model: 'hy-image-v3.5-preview', prompt: '一只猫', quality: 'high' }, planConfig()),
    isApiError(400, 'unsupported_parameter'),
  );
});

test('accepts raw base64 reference images and detects PNG', () => {
  const plan = buildGenerationPlan(
    { model: 'hy-image-v3.5-preview', prompt: '参考这只猫', image: TINY_PNG_BASE64 },
    planConfig(),
  );
  assert.equal(plan.images[0].mime, 'image/png');
  assert.match(plan.images[0].dataUrl, /^data:image\/png;base64,/);
});

test('legacy protocol rejects WebP while messages protocol accepts it', () => {
  const webp = 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=';

  assert.throws(
    () =>
      buildGenerationPlan(
        { model: 'HY-Image-v3.0-I2I-ToB-v1.0.1', prompt: '油画风格', image: webp },
        planConfig(),
      ),
    isApiError(400, 'unsupported_image_type'),
  );

  const plan = buildGenerationPlan(
    { model: 'hy-image-v3.5-preview', prompt: '油画风格', image: webp },
    planConfig(),
  );
  assert.equal(plan.images[0].mime, 'image/webp');
});

test('Bearer token becomes the CloudBase API Key for the request', () => {
  const credentials = resolveCredentials(
    request({ headers: { authorization: 'Bearer caller-key' } }),
    { apiKey: 'server-key' },
  );
  assert.deepEqual(credentials, { accessKey: 'caller-key' });
});

test('falls back to server credentials only when no Bearer token is sent', () => {
  assert.deepEqual(resolveCredentials(request(), { apiKey: 'server-key' }), { accessKey: 'server-key' });
  assert.deepEqual(
    resolveCredentials(request(), { secretId: 'id', secretKey: 'secret' }),
    { secretId: 'id', secretKey: 'secret' },
  );
  assert.equal(resolveCredentials(request(), {}), null);
});

test('maps upstream authentication failures to 502 with actionable wording', () => {
  const error = new Error('Request failed with status code 403 Bearer secret-value');
  error.code = '403';
  const mapped = mapUpstreamError(error, { envId: 'env-id' });
  assert.equal(mapped.statusCode, 502);
  assert.equal(mapped.code, 'upstream_authentication_error');
  assert.match(mapped.message, /env: env-id/);
  assert.match(mapped.message, /API Key/);
  assert.doesNotMatch(mapped.message, /secret-value/);
});

test('redacts credentials that appear in upstream text', () => {
  assert.equal(redactSecrets('Authorization: Bearer abc.def'), 'Authorization: Bearer [redacted]');
  assert.equal(redactSecrets('accessKey=tcb-live-123456'), 'accessKey=[redacted]');
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
});

test('maps upstream content moderation (422) to an OpenAI-style 400', () => {
  const error = new Error('Request failed with status code 422');
  error.code = '422';
  const mapped = mapUpstreamError(error);
  assert.equal(mapped.statusCode, 400);
  assert.equal(mapped.code, 'moderation_blocked');
});

test('startup requires an environment id but not credentials', () => {
  assert.throws(() => loadConfig({}), /CLOUDBASE_ENV_ID/);
  const config = loadConfig({ CLOUDBASE_ENV_ID: 'env-id' });
  assert.equal(config.apiKey, '');
  assert.equal(config.maxN, 10);
  assert.equal(config.port, 8080);
});

test('loads optional server-side fallback credentials', () => {
  const config = loadConfig({
    CLOUDBASE_ENV_ID: 'env-id',
    CLOUDBASE_APIKEY: 'api-key',
    DEFAULT_MODEL: 'ignored',
    MODEL_MAP: '{"x":"y"}',
  });
  assert.equal(config.apiKey, 'api-key');
  assert.equal(config.defaultModel, undefined);
});
