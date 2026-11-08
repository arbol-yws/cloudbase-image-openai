'use strict';

const crypto = require('crypto');
const tcb = require('@cloudbase/node-sdk');
const { ApiError, mapUpstreamError, redactSecrets } = require('./errors');

const CLIENT_TTL_MS = 10 * 60 * 1000;
const CLIENT_CACHE_MAX = 100;

// In-memory only: credentials are never written to disk or logged.
const clientCache = new Map();

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new ApiError(504, `CloudBase ${label} timed out after ${timeoutMs} ms.`, {
          code: 'upstream_timeout',
        }),
      );
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function deriveSeed(seed, index) {
  if (seed === undefined) return undefined;
  return index === 0 ? seed : seed + index;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  let firstError;

  async function worker() {
    while (firstError === undefined) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        if (firstError === undefined) firstError = err;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);

  if (firstError !== undefined) throw firstError;
  return results;
}

function createCloudbaseClient(config, credentials = {}) {
  const initOptions = {
    env: config.envId,
    timeout: config.upstreamTimeoutMs,
  };

  if (credentials.accessKey) {
    initOptions.accessKey = credentials.accessKey;
  } else if (credentials.secretId && credentials.secretKey) {
    initOptions.secretId = credentials.secretId;
    initOptions.secretKey = credentials.secretKey;
  } else {
    throw new ApiError(401, 'CloudBase credentials are missing for this request.', {
      code: 'missing_credentials',
    });
  }

  const app = tcb.init(initOptions);
  const ai = app.ai();
  const imageModels = new Map();

  /**
   * Protocol dispatch only. The legacy provider needs an explicit endpoint
   * when the request carries reference images; text-only calls keep the SDK
   * default endpoint. No model versions are enumerated here.
   */
  function getImageModel(provider, hasReferenceImages) {
    const variant = provider === 'hunyuan-image' && hasReferenceImages ? 'i2i' : 'text';
    const key = `${provider}:${variant}`;

    if (!imageModels.has(key)) {
      const model = ai.createImageModel(provider);
      if (provider === 'hunyuan-image' && hasReferenceImages) {
        const rules = model.generateImageSubUrlConfig?.['hunyuan-image'];
        if (Array.isArray(rules)) rules.unshift([/./, 'images/generations']);
      }
      imageModels.set(key, model);
    }

    return imageModels.get(key);
  }

  async function generateOne(plan, index) {
    const seed = deriveSeed(plan.seed, index);
    const timeoutMs = config.upstreamTimeoutMs + 5000;
    const label = `image generation (${plan.model})`;

    try {
      if (plan.protocol === 'messages') {
        const content = [{ type: 'text', text: plan.prompt }];
        for (const image of plan.images) {
          content.push({
            type: 'image_url',
            image_url: { url: image.kind === 'url' ? image.url : image.dataUrl },
          });
        }

        const payload = {
          model: plan.model,
          messages: [{ role: 'user', content }],
        };
        if (plan.size) payload.size = plan.size;
        if (seed !== undefined) payload.seed = seed;
        if (plan.session) payload.session = plan.session;
        if (plan.footnote) payload.footnote = plan.footnote;
        if (plan.generateMaxPixels) payload.generate_max_pixels = plan.generateMaxPixels;
        if (plan.resizeMaxPixels) payload.resize_max_pixels = plan.resizeMaxPixels;
        if (plan.useSearchTool) payload.use_search_tool = plan.useSearchTool;

        const result = await withTimeout(
          getImageModel(plan.spec.provider, false).generateImage(payload),
          timeoutMs,
          label,
        );
        const image = result?.choices?.[0]?.delta?.image;
        if (!image?.url) {
          const detail = result?.error?.message
            ? ` Upstream detail: ${redactSecrets(result.error.message)}`
            : '';
          throw new ApiError(502, `CloudBase ${label} returned no image.${detail}`, {
            code: 'upstream_empty_response',
          });
        }

        return {
          url: image.url,
          revisedPrompt: undefined,
          width: image.width,
          height: image.height,
        };
      }

      const payload = {
        model: plan.model,
        prompt: plan.prompt,
      };
      if (plan.size) payload.size = plan.size;
      if (seed !== undefined) payload.seed = seed;
      if (plan.footnote) payload.footnote = plan.footnote;
      if (plan.revise !== undefined) payload.revise = { value: plan.revise };

      const imageUrls = plan.images.filter((image) => image.kind === 'url').map((image) => image.url);
      const base64Images = plan.images
        .filter((image) => image.kind === 'base64')
        .map((image) => image.payload);
      if (imageUrls.length > 0) payload.image_urls = imageUrls;
      if (base64Images.length > 0) payload.images = base64Images;

      const result = await withTimeout(
        getImageModel(plan.spec.provider, plan.images.length > 0).generateImage(payload),
        timeoutMs,
        label,
      );
      const item = result?.data?.[0];
      if (!item?.url) {
        const detail = result?.error?.message
          ? ` Upstream detail: ${redactSecrets(result.error.message)}`
          : '';
        throw new ApiError(502, `CloudBase ${label} returned no image.${detail}`, {
          code: 'upstream_empty_response',
        });
      }

      return {
        url: item.url,
        revisedPrompt: item.revised_prompt,
      };
    } catch (err) {
      throw mapUpstreamError(err, { operation: label, envId: config.envId });
    }
  }

  async function generateImages(plan) {
    const indexes = Array.from({ length: plan.n }, (_, index) => index);
    return mapWithConcurrency(indexes, Math.min(config.maxConcurrency, plan.n), (index) =>
      generateOne(plan, index),
    );
  }

  return { generateImages };
}

function credentialsCacheKey(credentials) {
  const material = credentials.accessKey
    ? `ak:${credentials.accessKey}`
    : `sk:${credentials.secretId}:${credentials.secretKey}`;
  return crypto.createHash('sha256').update(material).digest('hex');
}

/**
 * Short-lived in-memory client cache keyed by a hash of the caller's
 * credential. Nothing is persisted.
 */
function getCloudbaseClient(config, credentials) {
  const key = credentialsCacheKey(credentials);
  const now = Date.now();
  const cached = clientCache.get(key);

  if (cached && now - cached.createdAt < CLIENT_TTL_MS) {
    return cached.client;
  }

  if (clientCache.size >= CLIENT_CACHE_MAX) {
    clientCache.delete(clientCache.keys().next().value);
  }

  const client = createCloudbaseClient(config, credentials);
  clientCache.set(key, { client, createdAt: now });
  return client;
}

module.exports = {
  createCloudbaseClient,
  getCloudbaseClient,
  mapWithConcurrency,
  deriveSeed,
};
