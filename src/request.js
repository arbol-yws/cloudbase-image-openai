'use strict';

const { ApiError } = require('./errors');
const { usesMessagesProtocol } = require('./models');
const { normalizeReferenceImages } = require('./images');

const RESPONSE_FORMATS = new Set(['url', 'b64_json']);

function requireString(body, field, code) {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(400, `\`${field}\` is required and must be a non-empty string.`, {
      param: field,
      code,
    });
  }
  return value.trim();
}

function optionalString(body, field) {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ApiError(400, `\`${field}\` must be a string.`, {
      param: field,
      code: `invalid_${field}`,
    });
  }
  return value;
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

/**
 * Build the three-step plan: OpenAI fields -> one of the two CloudBase
 * protocols. Size, prompt length, image count and model capabilities are
 * CloudBase's job; this adapter only checks field presence and type.
 */
function buildGenerationPlan(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'Request body must be a JSON object.', {
      code: 'invalid_request_body',
    });
  }

  const model = requireString(body, 'model', 'model_required');
  const prompt = requireString(body, 'prompt', 'invalid_prompt');
  const protocol = usesMessagesProtocol(model) ? 'messages' : 'legacy';

  return {
    model,
    prompt,
    protocol,
    provider: protocol === 'messages' ? 'cloudbase' : 'hunyuan-image',
    images: normalizeReferenceImages(body),
    n: parseN(body, config),
    size: optionalString(body, 'size'),
    responseFormat: parseResponseFormat(body),
    seed: parseSeed(body),
    revise: protocol === 'legacy'
      ? (typeof body.revise === 'boolean' ? body.revise : config.revisePrompt)
      : undefined,
  };
}

module.exports = { buildGenerationPlan };
