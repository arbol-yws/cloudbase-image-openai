'use strict';

const { ApiError } = require('./errors');
const { resolveModel } = require('./models');
const { normalizeReferenceImages } = require('./images');

const SUPPORTED_FIELDS = new Set([
  'model',
  'prompt',
  'n',
  'size',
  'response_format',
  'user',
  'image',
  'image[]',
  'images',
  'seed',
  'session',
  'footnote',
  'revise',
  'generate_max_pixels',
]);

const UNSUPPORTED_FIELD_MESSAGES = {
  quality:
    'CloudBase image models do not support `quality`. Remove it and describe the desired fidelity in `prompt`/`model`.',
  style: 'CloudBase image models do not support `style`. Put style guidance in `prompt` instead.',
  background: 'CloudBase image models do not support `background`. Describe the background in `prompt`.',
  output_format:
    'CloudBase image models do not support `output_format`. The output format is determined by the model (JPEG/PNG URL).',
  output_compression: 'CloudBase image models do not support `output_compression`.',
  moderation: 'CloudBase image models do not expose a `moderation` parameter.',
  stream: 'CloudBase image generation is synchronous; `stream` is not supported.',
  partial_images: 'CloudBase image models do not support `partial_images`.',
  input_fidelity: 'CloudBase image models do not support `input_fidelity`.',
  mask: 'CloudBase image-to-image does not support masks. Use `image`/`image[]` for reference images.',
};

const RESPONSE_FORMATS = new Set(['url', 'b64_json']);

function assertNoUnsupportedFields(body) {
  const unsupported = Object.keys(body).filter((field) => !SUPPORTED_FIELDS.has(field));
  if (unsupported.length === 0) return;

  const field = unsupported[0];
  const message = UNSUPPORTED_FIELD_MESSAGES[field]
    || `Unsupported parameter "${field}". Supported parameters: ${Array.from(SUPPORTED_FIELDS).join(', ')}.`;
  throw new ApiError(400, message, { param: field, code: 'unsupported_parameter' });
}

function parsePrompt(body, spec) {
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    throw new ApiError(400, '`prompt` is required and must be a non-empty string.', {
      param: 'prompt',
      code: 'invalid_prompt',
    });
  }
  if (body.prompt.length > spec.maxPromptChars) {
    throw new ApiError(
      400,
      `\`prompt\` is too long: ${body.prompt.length} characters, model ${spec.name} allows at most ${spec.maxPromptChars}.`,
      { param: 'prompt', code: 'prompt_too_long' },
    );
  }
  return body.prompt;
}

function parseN(body, config) {
  if (body.n === undefined || body.n === null) return 1;
  if (!Number.isInteger(body.n) || body.n < 1) {
    throw new ApiError(400, '`n` must be an integer greater than or equal to 1.', {
      param: 'n',
      code: 'invalid_n',
    });
  }
  if (body.n > config.maxN) {
    throw new ApiError(400, `\`n\` must not exceed ${config.maxN}.`, {
      param: 'n',
      code: 'invalid_n',
    });
  }
  return body.n;
}

function parseSize(body, spec) {
  if (body.size === undefined || body.size === null) return undefined;
  if (typeof body.size !== 'string') {
    throw new ApiError(400, '`size` must be "auto" or "WIDTHxHEIGHT".', {
      param: 'size',
      code: 'invalid_size',
    });
  }

  const value = body.size.trim().toLowerCase();
  if (value === 'auto') return undefined;

  const match = value.match(/^(\d{2,5})x(\d{2,5})$/);
  if (!match) {
    throw new ApiError(400, '`size` must be "auto" or "WIDTHxHEIGHT", for example "1024x1024".', {
      param: 'size',
      code: 'invalid_size',
    });
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (
    width < spec.minDimension ||
    width > spec.maxDimension ||
    height < spec.minDimension ||
    height > spec.maxDimension
  ) {
    throw new ApiError(
      400,
      `\`size\` ${width}x${height} is not supported by ${spec.name}: width and height must be between ${spec.minDimension} and ${spec.maxDimension}.`,
      { param: 'size', code: 'unsupported_size' },
    );
  }
  if (width * height > spec.maxArea) {
    throw new ApiError(
      400,
      `\`size\` ${width}x${height} is not supported by ${spec.name}: the maximum area is ${spec.maxArea} pixels.`,
      { param: 'size', code: 'unsupported_size' },
    );
  }

  return `${width}x${height}`;
}

function parseResponseFormat(body) {
  if (body.response_format === undefined || body.response_format === null) return 'url';
  if (typeof body.response_format !== 'string' || !RESPONSE_FORMATS.has(body.response_format)) {
    throw new ApiError(400, '`response_format` must be "url" or "b64_json".', {
      param: 'response_format',
      code: 'invalid_response_format',
    });
  }
  return body.response_format;
}

function parseSeed(body, spec) {
  if (body.seed === undefined || body.seed === null) return undefined;
  if (!Number.isSafeInteger(body.seed) || body.seed < spec.seedMin || body.seed > spec.seedMax) {
    throw new ApiError(
      400,
      `\`seed\` must be a safe integer between ${spec.seedMin} and ${spec.seedMax} for ${spec.name}.`,
      { param: 'seed', code: 'invalid_seed' },
    );
  }
  return body.seed;
}

function parseSession(body, spec) {
  if (body.session === undefined || body.session === null) return undefined;
  if (!spec.supportsSession) {
    throw new ApiError(400, `Model ${spec.name} does not support \`session\`.`, {
      param: 'session',
      code: 'unsupported_parameter',
    });
  }
  if (typeof body.session !== 'string' || !body.session.trim() || body.session.length > 128) {
    throw new ApiError(400, '`session` must be a non-empty string of at most 128 characters.', {
      param: 'session',
      code: 'invalid_session',
    });
  }
  return body.session.trim();
}

function parseFootnote(body) {
  if (body.footnote === undefined || body.footnote === null) return undefined;
  if (typeof body.footnote !== 'string' || Array.from(body.footnote).length > 16) {
    throw new ApiError(400, '`footnote` must be a string of at most 16 characters.', {
      param: 'footnote',
      code: 'invalid_footnote',
    });
  }
  return body.footnote;
}

function parseRevise(body, spec, config) {
  if (body.revise === undefined || body.revise === null) {
    return spec.supportsRevise ? config.revisePrompt : undefined;
  }
  if (!spec.supportsRevise) {
    throw new ApiError(400, `Model ${spec.name} does not support \`revise\`.`, {
      param: 'revise',
      code: 'unsupported_parameter',
    });
  }
  if (typeof body.revise !== 'boolean') {
    throw new ApiError(400, '`revise` must be a boolean.', {
      param: 'revise',
      code: 'invalid_revise',
    });
  }
  return body.revise;
}

function parseGenerateMaxPixels(body, spec) {
  if (body.generate_max_pixels === undefined || body.generate_max_pixels === null) return undefined;
  if (!spec.supportsGenerateMaxPixels) {
    throw new ApiError(400, `Model ${spec.name} does not support \`generate_max_pixels\`.`, {
      param: 'generate_max_pixels',
      code: 'unsupported_parameter',
    });
  }
  if (![1048576, 2359296, 4194304].includes(body.generate_max_pixels)) {
    throw new ApiError(
      400,
      '`generate_max_pixels` must be one of 1048576 (1K), 2359296 (1.5K), or 4194304 (2K).',
      { param: 'generate_max_pixels', code: 'invalid_generate_max_pixels' },
    );
  }
  return body.generate_max_pixels;
}

function parseUser(body) {
  if (body.user === undefined || body.user === null) return undefined;
  if (typeof body.user !== 'string' || body.user.length > 256) {
    throw new ApiError(400, '`user` must be a string of at most 256 characters.', {
      param: 'user',
      code: 'invalid_user',
    });
  }
  return body.user;
}

/**
 * Validate an OpenAI-style JSON body and convert it into an internal plan.
 */
function buildGenerationPlan(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'Request body must be a JSON object.', {
      code: 'invalid_request_body',
    });
  }

  assertNoUnsupportedFields(body);

  const spec = resolveModel(body.model, config.modelMap, config.defaultModel);
  const prompt = parsePrompt(body, spec);
  const images = normalizeReferenceImages(body, spec);
  const n = parseN(body, config);
  const size = parseSize(body, spec);
  const responseFormat = parseResponseFormat(body);
  const seed = parseSeed(body, spec);
  const session = parseSession(body, spec);
  const footnote = parseFootnote(body);
  const revise = parseRevise(body, spec, config);
  const generateMaxPixels = parseGenerateMaxPixels(body, spec);
  const user = parseUser(body);

  return {
    spec,
    model: spec.name,
    prompt,
    images,
    n,
    size,
    responseFormat,
    seed,
    session,
    footnote,
    revise,
    generateMaxPixels,
    user,
  };
}

module.exports = {
  buildGenerationPlan,
  SUPPORTED_FIELDS,
};
