'use strict';

const { ApiError } = require('./errors');
const { PROTOCOLS, resolveProtocol } = require('./models');
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
  'resize_max_pixels',
  'use_search_tool',
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

function parseModel(body) {
  if (body.model === undefined || body.model === null) {
    throw new ApiError(
      400,
      '`model` is required. Pass the CloudBase model identifier you want to use, for example "hy-image-v3.5-preview".',
      { param: 'model', code: 'model_required' },
    );
  }
  if (typeof body.model !== 'string' || !body.model.trim()) {
    throw new ApiError(400, '`model` must be a non-empty string.', {
      param: 'model',
      code: 'invalid_model',
    });
  }
  return body.model.trim();
}

function parsePrompt(body) {
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    throw new ApiError(400, '`prompt` is required and must be a non-empty string.', {
      param: 'prompt',
      code: 'invalid_prompt',
    });
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

function parseSize(body) {
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

  // Size limits are upstream policy, not adapter policy: forward the requested
  // dimensions and let CloudBase accept or reject them.
  return `${Number(match[1])}x${Number(match[2])}`;
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

function parseSeed(body) {
  if (body.seed === undefined || body.seed === null) return undefined;
  if (!Number.isSafeInteger(body.seed) || body.seed < 0) {
    throw new ApiError(400, '`seed` must be a non-negative integer.', {
      param: 'seed',
      code: 'invalid_seed',
    });
  }
  return body.seed;
}

function parseSession(body, spec) {
  if (body.session === undefined || body.session === null) return undefined;
  if (!spec.supportsSession) {
    throw new ApiError(400, `The ${spec.protocol} protocol does not support \`session\`.`, {
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
    throw new ApiError(400, `The ${spec.protocol} protocol does not support \`revise\`.`, {
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
    throw new ApiError(400, `The ${spec.protocol} protocol does not support \`generate_max_pixels\`.`, {
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

function parseResizeMaxPixels(body, spec) {
  if (body.resize_max_pixels === undefined || body.resize_max_pixels === null) return undefined;
  if (!spec.supportsResizeMaxPixels) {
    throw new ApiError(400, `The ${spec.protocol} protocol does not support \`resize_max_pixels\`.`, {
      param: 'resize_max_pixels',
      code: 'unsupported_parameter',
    });
  }
  if (!Number.isSafeInteger(body.resize_max_pixels) || body.resize_max_pixels <= 0) {
    throw new ApiError(400, '`resize_max_pixels` must be a positive integer.', {
      param: 'resize_max_pixels',
      code: 'invalid_resize_max_pixels',
    });
  }
  return body.resize_max_pixels;
}

function parseUseSearchTool(body, spec) {
  if (body.use_search_tool === undefined || body.use_search_tool === null) return undefined;
  if (!spec.supportsSearchTool) {
    throw new ApiError(400, `The ${spec.protocol} protocol does not support \`use_search_tool\`.`, {
      param: 'use_search_tool',
      code: 'unsupported_parameter',
    });
  }
  const value = body.use_search_tool.value;
  if (typeof body.use_search_tool !== 'object' || Array.isArray(body.use_search_tool) || typeof value !== 'boolean') {
    throw new ApiError(400, '`use_search_tool` must be an object shaped like { "value": true }.', {
      param: 'use_search_tool',
      code: 'invalid_use_search_tool',
    });
  }
  return { value };
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

  // The model is opaque to this adapter: it is forwarded to CloudBase as-is.
  // Only the wire protocol is chosen locally, from the model name prefix.
  const model = parseModel(body);
  const protocol = resolveProtocol(model);
  const spec = PROTOCOLS[protocol];

  const prompt = parsePrompt(body);
  const images = normalizeReferenceImages(body, spec);
  const n = parseN(body, config);
  const size = parseSize(body);
  const responseFormat = parseResponseFormat(body);
  const seed = parseSeed(body);
  const session = parseSession(body, spec);
  const footnote = parseFootnote(body);
  const revise = parseRevise(body, spec, config);
  const generateMaxPixels = parseGenerateMaxPixels(body, spec);
  const resizeMaxPixels = parseResizeMaxPixels(body, spec);
  const useSearchTool = parseUseSearchTool(body, spec);
  const user = parseUser(body);

  return {
    spec,
    model,
    protocol,
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
    resizeMaxPixels,
    useSearchTool,
    user,
  };
}

module.exports = {
  buildGenerationPlan,
  SUPPORTED_FIELDS,
};
