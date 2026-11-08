'use strict';

const tcb = require('@cloudbase/node-sdk');
const { ApiError, mapUpstreamError } = require('./errors');

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

function deriveSeed(seed, index, spec) {
  if (seed === undefined) return undefined;
  if (index === 0) return seed;
  const next = seed + index;
  return next <= spec.seedMax ? next : seed;
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

function createCloudbaseClient(config) {
  const initOptions = {
    env: config.envId,
    timeout: config.upstreamTimeoutMs,
  };

  if (config.apiKey) {
    initOptions.accessKey = config.apiKey;
  } else {
    initOptions.secretId = config.secretId;
    initOptions.secretKey = config.secretKey;
  }

  const app = tcb.init(initOptions);
  const ai = app.ai();
  const imageModels = new Map();

  function getImageModel(provider) {
    if (!imageModels.has(provider)) {
      imageModels.set(provider, ai.createImageModel(provider));
    }
    return imageModels.get(provider);
  }

  async function generateOne(plan, index) {
    const spec = plan.spec;
    const seed = deriveSeed(plan.seed, index, spec);
    const timeoutMs = config.upstreamTimeoutMs + 5000;
    const label = `image generation (${spec.name})`;

    try {
      if (spec.protocol === 'messages') {
        const content = [{ type: 'text', text: plan.prompt }];
        for (const image of plan.images) {
          content.push({
            type: 'image_url',
            image_url: { url: image.kind === 'url' ? image.url : image.dataUrl },
          });
        }

        const payload = {
          model: spec.name,
          messages: [{ role: 'user', content }],
        };
        if (plan.size) payload.size = plan.size;
        if (seed !== undefined) payload.seed = seed;
        if (plan.session) payload.session = plan.session;
        if (plan.footnote) payload.footnote = plan.footnote;
        if (plan.generateMaxPixels) payload.generate_max_pixels = plan.generateMaxPixels;

        const result = await withTimeout(
          getImageModel(spec.provider).generateImage(payload),
          timeoutMs,
          label,
        );
        const image = result?.choices?.[0]?.delta?.image;
        if (!image?.url) {
          const upstreamDetail = result?.error?.message ? ` Upstream detail: ${result.error.message}` : '';
          throw new ApiError(502, `CloudBase ${label} returned no image.${upstreamDetail}`, {
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
        model: spec.name,
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
        getImageModel(spec.provider).generateImage(payload),
        timeoutMs,
        label,
      );
      const item = result?.data?.[0];
      if (!item?.url) {
        const upstreamDetail = result?.error?.message ? ` Upstream detail: ${result.error.message}` : '';
        throw new ApiError(502, `CloudBase ${label} returned no image.${upstreamDetail}`, {
          code: 'upstream_empty_response',
        });
      }

      return {
        url: item.url,
        revisedPrompt: item.revised_prompt,
      };
    } catch (err) {
      throw mapUpstreamError(err, { operation: label });
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

module.exports = { createCloudbaseClient, mapWithConcurrency, deriveSeed };
