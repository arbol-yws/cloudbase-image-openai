'use strict';

const { ApiError } = require('./errors');

const MB = 1024 * 1024;

/**
 * Capabilities verified against the CloudBase Node SDK docs and the installed
 * @cloudbase/ai 2.x image model implementation.
 *
 * cloudbase provider / hy-image-v3.5-preview:
 *   - Chat/Messages protocol, text + reference image content parts
 *   - up to 20 reference images, each <= 20 MB
 *   - width/height in [256, 8192], area <= 4096 x 4096
 *   - output URL expires after 12 hours
 *
 * hunyuan-image provider / HY-Image-v3.0-I2I-ToB-v1.0.1:
 *   - classic prompt/image_urls/images payload
 *   - exactly one reference image, <= 10 MB, jpg/jpeg/png
 *   - width/height in [512, 2048], area <= 1024 x 1024
 *   - output URL expires after 24 hours
 *   - marked as a legacy model by CloudBase documentation
 */
const MODEL_SPECS = Object.freeze({
  'hy-image-v3.5-preview': Object.freeze({
    name: 'hy-image-v3.5-preview',
    provider: 'cloudbase',
    protocol: 'messages',
    requiresImage: false,
    maxImages: 20,
    maxImageBytes: 20 * MB,
    allowedImageMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
    minDimension: 256,
    maxDimension: 8192,
    maxArea: 4096 * 4096,
    maxPromptChars: 8192,
    seedMin: 0,
    seedMax: Number.MAX_SAFE_INTEGER,
    supportsSession: true,
    supportsRevise: false,
    supportsGenerateMaxPixels: true,
  }),
  'HY-Image-v3.0-I2I-ToB-v1.0.1': Object.freeze({
    name: 'HY-Image-v3.0-I2I-ToB-v1.0.1',
    provider: 'hunyuan-image',
    protocol: 'legacy',
    requiresImage: true,
    maxImages: 1,
    maxImageBytes: 10 * MB,
    allowedImageMimeTypes: ['image/png', 'image/jpeg'],
    minDimension: 512,
    maxDimension: 2048,
    maxArea: 1024 * 1024,
    maxPromptChars: 8192,
    seedMin: 1,
    seedMax: 4294967295,
    supportsSession: false,
    supportsRevise: true,
    supportsGenerateMaxPixels: false,
  }),
});

/**
 * Built-in OpenAI-friendly aliases. Users can extend/override with MODEL_MAP.
 * All aliases are matched case-insensitively.
 */
const BUILTIN_MODEL_MAP = Object.freeze({
  'hy-image-v3.5-preview': 'hy-image-v3.5-preview',
  'cloudbase': 'hy-image-v3.5-preview',
  'cloudbase-image': 'hy-image-v3.5-preview',
  'cloudbase-image-3.5': 'hy-image-v3.5-preview',
  'gpt-image-1': 'hy-image-v3.5-preview',
  'gpt-image-1.5': 'hy-image-v3.5-preview',
  'dall-e-3': 'hy-image-v3.5-preview',
  'dall-e-2': 'hy-image-v3.5-preview',
  'cloudbase-i2i': 'HY-Image-v3.0-I2I-ToB-v1.0.1',
  'cloudbase-image-i2i': 'HY-Image-v3.0-I2I-ToB-v1.0.1',
  'hunyuan-image-i2i': 'HY-Image-v3.0-I2I-ToB-v1.0.1',
  'HY-Image-v3.0-I2I-ToB-v1.0.1': 'HY-Image-v3.0-I2I-ToB-v1.0.1',
});

function getModelSpec(name) {
  if (typeof name !== 'string') return null;
  return MODEL_SPECS[name] || null;
}

function buildModelMap(overrides = {}) {
  const map = {};
  for (const [alias, target] of Object.entries({ ...BUILTIN_MODEL_MAP, ...overrides })) {
    const spec = getModelSpec(target);
    if (!spec) {
      throw new Error(`MODEL_MAP entry "${alias}" maps to unsupported CloudBase model "${target}"`);
    }
    map[alias.toLowerCase()] = spec.name;
  }
  return map;
}

function resolveModel(requestedModel, modelMap, defaultModel) {
  let model = requestedModel;
  if (model === undefined || model === null || model === '') {
    model = defaultModel;
  }
  if (typeof model !== 'string' || !model.trim()) {
    throw new ApiError(400, '`model` must be a non-empty string.', {
      param: 'model',
      code: 'invalid_model',
    });
  }

  model = model.trim();
  if (model.toLowerCase() === 'auto') {
    model = defaultModel;
  }

  const canonical = modelMap[model.toLowerCase()];
  if (!canonical) {
    const supported = Object.keys(modelMap).sort().join(', ');
    throw new ApiError(400, `Unknown image model "${model}". Supported model aliases: ${supported}.`, {
      param: 'model',
      code: 'model_not_found',
    });
  }

  return getModelSpec(canonical);
}

module.exports = {
  MODEL_SPECS,
  BUILTIN_MODEL_MAP,
  getModelSpec,
  buildModelMap,
  resolveModel,
};
