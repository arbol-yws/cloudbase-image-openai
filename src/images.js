'use strict';

const { ApiError } = require('./errors');

/**
 * Reference images are a CloudBase extension on top of the OpenAI fields.
 * Only the format is normalized here; image count, type support and size
 * limits are left to CloudBase.
 *
 * URL          -> used as-is
 * data URL     -> used as-is for messages, raw base64 for the legacy provider
 * raw base64   -> wrapped in a data URL for messages, raw for the legacy provider
 */
function sniffMime(base64) {
  const head = Buffer.from(base64.slice(0, 32), 'base64');
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (head.length >= 3 && head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return 'image/jpeg';
  }
  if (
    head.length >= 12
    && head.subarray(0, 4).toString('ascii') === 'RIFF'
    && head.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/png';
}

function normalizeReference(value, index) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(400, `Reference image ${index} must be a URL, data URL, or base64 string.`, {
      param: 'image',
      code: 'invalid_image',
    });
  }

  const raw = value.trim();

  if (/^https?:\/\//i.test(raw)) {
    return { kind: 'url', url: raw };
  }

  if (/^data:/i.test(raw)) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(raw);
    if (!match) {
      throw new ApiError(400, `Reference image ${index} must be an image data URL.`, {
        param: 'image',
        code: 'invalid_image',
      });
    }
    return {
      kind: 'base64',
      mime: match[1].toLowerCase(),
      payload: match[2],
      dataUrl: raw,
    };
  }

  const payload = raw.replace(/\s+/g, '');
  return {
    kind: 'base64',
    mime: sniffMime(payload),
    payload,
    dataUrl: `data:${sniffMime(payload)};base64,${payload}`,
  };
}

function normalizeReferenceImages(body) {
  const raw = body.image ?? body['image[]'] ?? body.images;
  if (raw === undefined || raw === null) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((value, index) => normalizeReference(value, index));
}

module.exports = { normalizeReferenceImages };
