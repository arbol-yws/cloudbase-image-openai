'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../src/config');
const { buildGenerationPlan } = require('../src/request');
const { usesMessagesProtocol } = require('../src/models');
const { resolveCredentials } = require('../src/app');
const { ApiError, mapUpstreamError, redactSecrets } = require('../src/errors');
const { createCloudbaseClient } = require('../src/cloudbase');
const { buildOpenAIResponse } = require('../src/response');
const { createCapture, runWithContext, recordResponse } = require('../src/upstream-capture');

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function planConfig(overrides = {}) {
  return { maxN: 10, revisePrompt: true, ...overrides };
}

function clientConfig(overrides = {}) {
  return {
    envId: 'env-id',
    upstreamTimeoutMs: 5000,
    maxN: 10,
    revisePrompt: true,
    ...overrides,
  };
}

function request(overrides = {}) {
  return { headers: {}, get(name) { return this.headers[name.toLowerCase()] || ''; }, ...overrides };
}

function isApiError(statusCode, code) {
  return (err) => err instanceof ApiError && err.statusCode === statusCode && err.code === code;
}

function fakeSdk(models) {
  return {
    init() {
      return {
        ai() {
          return {
            createImageModel(provider) {
              return models[provider];
            },
          };
        },
      };
    },
  };
}

test('requires model and prompt with basic type checks', () => {
  assert.throws(
    () => buildGenerationPlan({ prompt: '一只猫' }, planConfig()),
    isApiError(400, 'model_required'),
  );
  assert.throws(
    () => buildGenerationPlan({ model: 'hy-image-v3.5-preview' }, planConfig()),
    isApiError(400, 'invalid_prompt'),
  );
  assert.throws(
    () => buildGenerationPlan({ model: 42, prompt: '猫' }, planConfig()),
    isApiError(400, 'model_required'),
  );
  assert.throws(
    () => buildGenerationPlan({ model: 'hy-image-v3.5-preview', prompt: '猫', n: 0 }, planConfig()),
    isApiError(400, 'invalid_n'),
  );
  assert.throws(
    () => buildGenerationPlan({ model: 'hy-image-v3.5-preview', prompt: '猫', response_format: 'png' }, planConfig()),
    isApiError(400, 'invalid_response_format'),
  );
});

test('forwards the model identifier verbatim and only dispatches the protocol', () => {
  assert.equal(usesMessagesProtocol('hy-image-v3.5-preview'), true);
  assert.equal(usesMessagesProtocol('hy-image-experimental'), true);
  assert.equal(usesMessagesProtocol('HY-Image-v3.0-I2I-ToB-v1.0.1'), false);
  assert.equal(usesMessagesProtocol('HY-Image-3.0-Plus-4090-Tob-v1.0'), false);

  const plan = buildGenerationPlan(
    { model: 'some-future-cloudbase-model', prompt: '一只猫' },
    planConfig(),
  );
  assert.equal(plan.model, 'some-future-cloudbase-model');
  assert.equal(plan.protocol, 'legacy');
  assert.equal(plan.provider, 'hunyuan-image');
});

test('does not duplicate CloudBase size, prompt, or image-count rules', () => {
  const plan = buildGenerationPlan(
    {
      model: 'HY-Image-v3.0-I2I-ToB-v1.0.1',
      prompt: '猫'.repeat(1000),
      size: '1792x1024',
      image: ['https://example.com/a.png', 'https://example.com/b.png'],
      seed: 4294967296,
    },
    planConfig(),
  );
  assert.equal(plan.protocol, 'legacy');
  assert.equal(plan.images.length, 2);
  assert.equal(plan.size, '1792x1024');
  assert.equal(plan.seed, 4294967296);
});

test('normalizes URL, data URL, and raw base64 reference images', () => {
  const plan = buildGenerationPlan(
    {
      model: 'hy-image-v3.5-preview',
      prompt: '参考这些图',
      image: ['https://example.com/a.png', TINY_PNG_BASE64],
    },
    planConfig(),
  );

  assert.equal(plan.images[0].kind, 'url');
  assert.equal(plan.images[1].kind, 'base64');
  assert.equal(plan.images[1].mime, 'image/png');
  assert.match(plan.images[1].dataUrl, /^data:image\/png;base64,/);
  assert.equal(plan.images[1].payload, TINY_PNG_BASE64);
});

test('messages protocol sends reference images inside messages content', async () => {
  let received;
  const model = {
    async generateImage(payload) {
      received = payload;
      return { choices: [{ delta: { image: { url: 'https://example.com/out.png' } } }] };
    },
  };
  const client = createCloudbaseClient(
    clientConfig(),
    { accessKey: 'caller-key' },
    fakeSdk({ cloudbase: model }),
  );

  const plan = buildGenerationPlan(
    {
      model: 'hy-image-v3.5-preview',
      prompt: '参考这张图画一只猫',
      image: 'https://example.com/reference.png',
      size: '1024x1024',
    },
    planConfig(),
  );
  const results = await client.generateImages(plan);

  assert.deepEqual(results, [{ url: 'https://example.com/out.png' }]);
  assert.equal(received.messages[0].content[0].type, 'text');
  assert.equal(received.messages[0].content[1].image_url.url, 'https://example.com/reference.png');
});

test('legacy protocol maps URL references to image_urls and base64 to images', async () => {
  const received = [];
  const model = {
    async generateImage(payload) {
      received.push(payload);
      return { data: [{ url: 'https://example.com/out.png' }] };
    },
  };
  const client = createCloudbaseClient(
    clientConfig(),
    { accessKey: 'caller-key' },
    fakeSdk({ 'hunyuan-image': model }),
  );

  const urlPlan = buildGenerationPlan(
    {
      model: 'HY-Image-v3.0-I2I-ToB-v1.0.1',
      prompt: '油画风格',
      image: 'https://example.com/reference.png',
    },
    planConfig(),
  );
  await client.generateImages(urlPlan);
  assert.deepEqual(received[0].image_urls, ['https://example.com/reference.png']);
  assert.equal(received[0].images, undefined);

  const base64Plan = buildGenerationPlan(
    {
      model: 'HY-Image-v3.0-I2I-ToB-v1.0.1',
      prompt: '油画风格',
      image: TINY_PNG_BASE64,
    },
    planConfig(),
  );
  await client.generateImages(base64Plan);
  assert.deepEqual(received[1].images, [TINY_PNG_BASE64]);
  assert.equal(received[1].image_urls, undefined);
});

test('legacy image-to-image requests keep the SDK default AR endpoint config', async () => {
  const tcb = require('@cloudbase/node-sdk');
  const realModel = tcb
    .init({ env: 'probe-env', accessKey: 'probe-key' })
    .ai()
    .createImageModel('hunyuan-image');

  const before = JSON.stringify(realModel.generateImageSubUrlConfig);
  realModel.generateImage = async () => ({ data: [{ url: 'https://example.com/out.png' }] });

  const client = createCloudbaseClient(
    clientConfig({ envId: 'probe-env' }),
    { accessKey: 'probe-key' },
    fakeSdk({ 'hunyuan-image': realModel }),
  );

  const plan = buildGenerationPlan(
    {
      model: 'HY-Image-v3.0-I2I-ToB-v1.0.1',
      prompt: '油画风格',
      image: 'https://example.com/reference.png',
    },
    planConfig(),
  );
  await client.generateImages(plan);

  assert.equal(JSON.stringify(realModel.generateImageSubUrlConfig), before);
  assert.equal(realModel.defaultGenerateImageSubUrl, 'images/ar/generations');
  const legacyRules = realModel.generateImageSubUrlConfig['hunyuan-image'];
  assert.equal(legacyRules.some(([pattern]) => pattern.test('HY-Image-v3.0-I2I-ToB-v1.0.1')), false);
  assert.equal(
    `${realModel.baseUrl}/hunyuan-image/${realModel.defaultGenerateImageSubUrl}`,
    'https://probe-env.api.tcloudbasegateway.com/v1/ai/hunyuan-image/images/ar/generations',
  );
});

test('empty upstream responses log the response body without changing the API shape', async () => {
  const model = { async generateImage() { return {}; } };
  const client = createCloudbaseClient(
    clientConfig(),
    { accessKey: 'caller-key' },
    fakeSdk({ cloudbase: model }),
  );
  const plan = buildGenerationPlan({ model: 'hy-image-v3.5-preview', prompt: '一只猫' }, planConfig());

  await assert.rejects(
    () => client.generateImages(plan),
    (err) => {
      assert.equal(err.statusCode, 502);
      assert.equal(err.code, 'upstream_empty_response');
      assert.equal(err.upstream.body_available, true);
      assert.match(err.upstream.body, /\{\}/);
      assert.deepEqual(Object.keys(err.toJSON().error).sort(), ['code', 'message', 'param', 'type']);
      return true;
    },
  );
});

test('extracts an axios-style upstream 400 body for logging and redacts it', () => {
  const error = new Error('Request failed with status code 400');
  error.code = '400';
  error.response = {
    status: 400,
    headers: { 'x-cloudbase-request-id': 'rid-from-header', authorization: 'Bearer secret-value' },
    data: { error: { code: 'InvalidParameter', message: 'image_urls is invalid: Bearer secret-value' } },
  };

  const mapped = mapUpstreamError(error, { envId: 'env-id' });

  assert.equal(mapped.statusCode, 400);
  assert.equal(mapped.code, 'upstream_invalid_request');
  assert.equal(mapped.upstream.status, 400);
  assert.match(mapped.upstream.body, /InvalidParameter/);
  assert.doesNotMatch(mapped.upstream.body, /secret-value/);
  assert.equal(mapped.upstream.headers.authorization, undefined);
  assert.doesNotMatch(mapped.message, /image_urls is invalid/);
  assert.deepEqual(Object.keys(mapped.toJSON().error).sort(), ['code', 'message', 'param', 'type']);
});

test('captures the SDK transport response body through AsyncLocalStorage', async () => {
  const capture = createCapture();

  await runWithContext(capture, async () => {
    recordResponse(
      {
        statusCode: 400,
        headers: { 'x-cloudbase-request-id': 'rid-from-capture' },
        body: { error: { code: 'InvalidParameter', message: 'images must contain 1 item' } },
      },
      { method: 'POST', url: 'https://example.com/upstream' },
    );
  });

  assert.equal(capture.last.statusCode, 400);
  assert.equal(capture.last.request_id, 'rid-from-capture');
  assert.equal(capture.last.body.json.error.code, 'InvalidParameter');

  const mapped = mapUpstreamError(new Error('Request failed with status code 400'), { capture });
  assert.equal(mapped.upstream.status, 400);
  assert.equal(mapped.upstream.body_available, true);
  assert.match(mapped.upstream.body, /images must contain 1 item/);
});

test('marks the upstream body as unavailable when the SDK swallowed it', () => {
  const error = new Error('Request failed with status code 400');
  error.code = '400';
  const mapped = mapUpstreamError(error, { envId: 'env-id' });

  assert.equal(mapped.statusCode, 400);
  assert.equal(mapped.upstream.body_available, false);
  assert.equal(mapped.upstream.body, null);
});

test('builds exactly the OpenAI success structure', async () => {
  const response = await buildOpenAIResponse(
    [{ url: 'https://example.com/out.png' }],
    { responseFormat: 'url' },
    {},
  );
  assert.deepEqual(Object.keys(response).sort(), ['created', 'data']);
  assert.deepEqual(response.data, [{ url: 'https://example.com/out.png' }]);
});

test('Bearer token becomes the CloudBase API Key for the request', () => {
  const credentials = resolveCredentials(
    request({ headers: { authorization: 'Bearer caller-key' } }),
    { apiKey: 'server-key' },
  );
  assert.deepEqual(credentials, { accessKey: 'caller-key' });
});

test('rejects an Authorization header without the Bearer scheme', () => {
  assert.equal(resolveCredentials(request({ headers: { authorization: 'raw-cloudbase-key' } }), {}), null);
  assert.equal(resolveCredentials(request({ headers: { authorization: 'Bearer   ' } }), {}), null);
});

test('falls back to server credentials only when no Bearer token is sent', () => {
  assert.deepEqual(resolveCredentials(request(), { apiKey: 'server-key' }), { accessKey: 'server-key' });
  assert.deepEqual(
    resolveCredentials(request(), { secretId: 'id', secretKey: 'secret' }),
    { secretId: 'id', secretKey: 'secret' },
  );
  assert.equal(resolveCredentials(request(), {}), null);
});

test('maps upstream authentication failures to 502 without putting details in message', () => {
  const error = new Error('Request failed with status code 403 Bearer secret-value');
  error.code = '403';
  const mapped = mapUpstreamError(error, { envId: 'env-id' });
  assert.equal(mapped.statusCode, 502);
  assert.equal(mapped.code, 'upstream_authentication_error');
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

test('startup requires an environment id but not credentials', () => {
  assert.throws(() => loadConfig({}), /CLOUDBASE_ENV_ID/);
  const config = loadConfig({ CLOUDBASE_ENV_ID: 'env-id' });
  assert.equal(config.apiKey, '');
  assert.equal(config.maxN, 10);
  assert.equal(config.port, 8080);
});
