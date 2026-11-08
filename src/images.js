'use strict';

const { ApiError } = require('./errors');

const DATA_URL_RE = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([\s\S]+)$/i;

function normalizeMime(mime) {
  const lower = String(mime).toLowerCase();
  return lower === 'image/jpg' ? 'image/jpeg' : lower;
}

function normalizeBase64(payload, index) {
  const compact = String(payload).replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new ApiError(
      400,
      `Reference image ${index} is not valid base64 data. Use a data:image/...;base64 URL or a public http(s) URL.`,
      { param: 'image', code: 'invalid_image' },
    );
  }
  if (compact.length % 4 === 0) return compact;
  return compact + '='.repeat(4 - (compact.length % 4));
}

function sniffMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function assertMimeAllowed(mime, spec, index) {
  if (!spec.allowedImageMimeTypes.includes(mime)) {
    throw new ApiError(
      400,
      `Reference image ${index} has type ${mime}, but the ${spec.protocol} protocol supports ${spec.allowedImageMimeTypes.join(', ')}.`,
      { param: 'image', code: 'unsupported_image_type' },
    );
  }
}

function assertSizeAllowed(bytes, spec, index) {
  if (bytes > spec.maxImageBytes) {
    throw new ApiError(
      400,
      `Reference image ${index} is ${(bytes / 1024 / 1024).toFixed(2)} MB, but the ${spec.protocol} protocol allows at most ${(spec.maxImageBytes / 1024 / 1024).toFixed(0)} MB per image.`,
      { param: 'image', code: 'image_too_large' },
    );
  }
}

function parseImageValue(rawValue, spec, index) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    throw new ApiError(
      400,
      `Reference image ${index} must be a public http(s) URL, a data:image/...;base64 URL, or raw base64 data.`,
      { param: 'image', code: 'invalid_image' },
    );
  }

  const value = rawValue.trim();

  if (/^https?:\/\//i.test(value)) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new ApiError(400, `Reference image ${index} is not a valid URL.`, {
        param: 'image',
        code: 'invalid_image',
      });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ApiError(400, `Reference image ${index} must use http or https.`, {
        param: 'image',
        code: 'invalid_image',
      });
    }
    return { kind: 'url', value, url: value, bytes: 0 };
  }

  if (/^data:/i.test(value)) {
    const match = value.match(DATA_URL_RE);
    if (!match) {
      throw new ApiError(
        400,
        `Reference image ${index} uses an unsupported data URL. Supported types: image/png, image/jpeg, image/webp.`,
        { param: 'image', code: 'unsupported_image_type' },
      );
    }
    const mime = normalizeMime(match[1]);
    const payload = normalizeBase64(match[2], index);
    const bytes = Buffer.from(payload, 'base64').length;
    assertMimeAllowed(mime, spec, index);
    assertSizeAllowed(bytes, spec, index);
    return {
      kind: 'base64',
      value,
      mime,
      payload,
      bytes,
      dataUrl: `data:${mime};base64,${payload}`,
    };
  }

  const payload = normalizeBase64(value, index);
  const buffer = Buffer.from(payload, 'base64');
  const mime = sniffMime(buffer);
  if (!mime) {
    throw new ApiError(
      400,
      `Reference image ${index} has an undetectable image type. Send a data:image/png;base64,... URL, a data:image/jpeg;base64,... URL, or a public http(s) URL.`,
      { param: 'image', code: 'unsupported_image_type' },
    );
  }
  assertMimeAllowed(mime, spec, index);
  assertSizeAllowed(buffer.length, spec, index);
  return {
    kind: 'base64',
    value: `data:${mime};base64,${payload}`,
    mime,
    payload,
    bytes: buffer.length,
    dataUrl: `data:${mime};base64,${payload}`,
  };
}

function collectImageValues(body) {
  const values = [];
  let field;
  for (const key of ['image', 'image[]', 'images']) {
    const raw = body[key];
    if (raw === undefined || raw === null) continue;
    field = key;
    if (Array.isArray(raw)) {
      values.push(...raw);
    } else {
      values.push(raw);
    }
  }
  return { values, field };
}

function normalizeReferenceImages(body, spec) {
  const { values, field = 'image' } = collectImageValues(body);

  if (values.length === 0) return [];

  if (values.length > spec.maxImages) {
    throw new ApiError(
      400,
      `The ${spec.protocol} protocol accepts at most ${spec.maxImages} reference image(s) per request, but ${values.length} were provided.`,
      { param: field, code: 'too_many_images' },
    );
  }

  return values.map((value, index) => parseImageValue(value, spec, index));
}

module.exports = {
  normalizeReferenceImages,
  parseImageValue,
  normalizeBase64,
  sniffMime,
};
