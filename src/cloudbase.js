'use strict';

const tcb = require('@cloudbase/node-sdk');
const { ApiError, mapUpstreamError, responseRecord } = require('./errors');
const { createCapture, runWithContext } = require('./upstream-capture');

function createCloudbaseClient(config, credentials, sdk = tcb) {
  if (!credentials?.accessKey && !(credentials?.secretId && credentials?.secretKey)) {
    throw new ApiError(401, 'CloudBase credentials are missing for this request.', {
      code: 'missing_credentials',
    });
  }

  const app = sdk.init({
    env: config.envId,
    timeout: config.upstreamTimeoutMs,
    ...credentials,
  });
  const ai = app.ai();
  const models = new Map();

  // The SDK owns endpoint selection. The adapter only chooses the provider and
  // never rewrites generateImageSubUrlConfig.
  function getModel(provider) {
    if (!models.has(provider)) {
      models.set(provider, ai.createImageModel(provider));
    }
    return models.get(provider);
  }

  async function callModel(provider, payload) {
    const capture = createCapture();
    try {
      const result = await runWithContext(capture, () => getModel(provider).generateImage(payload));
      return { result, capture };
    } catch (err) {
      throw mapUpstreamError(err, { capture });
    }
  }

  async function generateOne(plan, index) {
    const seed = plan.seed === undefined ? undefined : plan.seed + index;

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

      const { result, capture } = await callModel(plan.provider, payload);
      const image = result?.choices?.[0]?.delta?.image;
      if (!image?.url) {
        throw new ApiError(502, 'CloudBase returned no image.', {
          code: 'upstream_empty_response',
          upstream: responseRecord(result, capture),
        });
      }
      return { url: image.url };
    }

    const payload = { model: plan.model, prompt: plan.prompt };
    if (plan.size) payload.size = plan.size;
    if (seed !== undefined) payload.seed = seed;
    if (plan.revise !== undefined) payload.revise = { value: plan.revise };

    // Documented legacy reference-image fields: URL -> image_urls,
    // base64 -> images. Count and type support are CloudBase's decision.
    const urls = plan.images.filter((image) => image.kind === 'url').map((image) => image.url);
    const base64 = plan.images.filter((image) => image.kind === 'base64').map((image) => image.payload);
    if (urls.length > 0) payload.image_urls = urls;
    if (base64.length > 0) payload.images = base64;

    const { result, capture } = await callModel(plan.provider, payload);
    const item = result?.data?.[0];
    if (!item?.url) {
      throw new ApiError(502, 'CloudBase returned no image.', {
        code: 'upstream_empty_response',
        upstream: responseRecord(result, capture),
      });
    }
    return { url: item.url };
  }

  async function generateImages(plan) {
    return Promise.all(Array.from({ length: plan.n }, (_, index) => generateOne(plan, index)));
  }

  return { generateImages };
}

module.exports = { createCloudbaseClient };
