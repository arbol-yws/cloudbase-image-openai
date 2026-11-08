'use strict';

const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const { ApiError } = require('./errors');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Documented messages tier: generate_max_pixels default 2359296 (1.5K).
const MESSAGES_TARGET_PIXELS = 2359296;
const MESSAGES_MAX_AREA = 4096 * 4096;
const MESSAGES_MIN_SIDE = 256;
const MESSAGES_MAX_SIDE = 8192;

// Documented legacy sizes for HY-Image-3.0 models.
const LEGACY_SIZES = [[1024, 1024], [1280, 720], [720, 1280], [1280, 1280]];

// Reading the image header only: PNG IHDR / WebP header / JPEG SOF all live
// near the start of the file. Cap the download instead of pulling whole images.
const REFERENCE_HEAD_BYTES = 256 * 1024;
const REFERENCE_FETCH_TIMEOUT_MS = 8000;

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
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) {
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

function readPngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readJpegSize(buffer) {
  let offset = 2;
  while (offset + 9 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return {
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += 2 + length;
  }
  return undefined;
}

function readWebpSize(buffer) {
  if (buffer.length < 30) return undefined;
  const chunk = buffer.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8 ') {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L' && buffer.length >= 25) {
    const [b0, b1, b2, b3] = [buffer[21], buffer[22], buffer[23], buffer[24]];
    return {
      width: (b0 | ((b1 & 0x3f) << 8)) + 1,
      height: (((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10))) + 1,
    };
  }
  if (chunk === 'VP8X') {
    return {
      width: buffer.readUIntLE(24, 3) + 1,
      height: buffer.readUIntLE(27, 3) + 1,
    };
  }
  return undefined;
}

function readImageSize(buffer) {
  if (!buffer || buffer.length < 16) return undefined;
  const jpeg = readJpegSize(buffer);
  if (jpeg) return jpeg;
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return readPngSize(buffer);
  if (
    buffer.length >= 16
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return readWebpSize(buffer);
  }
  return undefined;
}

function isPublicAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a >= 224) return false; // multicast / reserved
    return true;
  }

  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPublicAddress(mapped[1]);
  if (lower === '::' || lower === '::1') return false;
  if (/^fe[89ab]/.test(lower)) return false; // link-local
  if (/^f[cd]/.test(lower)) return false; // unique local
  return true;
}

// DNS lookup guard so a caller-supplied URL cannot reach loopback, LAN or
// metadata endpoints. Redirects are not followed by node:http/https anyway.
function publicOnlyLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, family: options?.family || 0, hints: options?.hints || 0 }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length) return callback(new Error('reference image host resolved to no address'));
    const blocked = addresses.find((entry) => !isPublicAddress(entry.address));
    if (blocked) return callback(new Error('reference image host is not a public address'));
    if (options?.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function readRemoteImageHead(url) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return resolve(undefined);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return resolve(undefined);

    const transport = parsed.protocol === 'https:' ? https : http;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const request = transport.get({
      protocol: parsed.protocol,
      hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      lookup: publicOnlyLookup,
      timeout: REFERENCE_FETCH_TIMEOUT_MS,
      headers: { accept: 'image/*', 'user-agent': 'cloudbase-image-openai' },
    }, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        return resolve(undefined);
      }

      const chunks = [];
      let total = 0;
      const finish = () => resolve(readImageSize(Buffer.concat(chunks)));

      response.on('data', (chunk) => {
        if (total >= REFERENCE_HEAD_BYTES) {
          response.destroy();
          return finish();
        }
        chunks.push(chunk);
        total += chunk.length;
        if (total >= REFERENCE_HEAD_BYTES) {
          response.destroy();
          finish();
        }
      });
      response.on('end', finish);
      response.on('error', () => resolve(undefined));
    });

    request.on('timeout', () => {
      request.destroy();
      resolve(undefined);
    });
    request.on('error', () => resolve(undefined));
  });
}

function fitMessagesSize({ width, height }) {
  const scale = Math.sqrt(MESSAGES_TARGET_PIXELS / (width * height));
  const outWidth = Math.max(MESSAGES_MIN_SIDE, Math.min(MESSAGES_MAX_SIDE, Math.round(width * scale)));
  const outHeight = Math.max(MESSAGES_MIN_SIDE, Math.min(MESSAGES_MAX_SIDE, Math.round(height * scale)));
  if (outWidth * outHeight > MESSAGES_MAX_AREA) return undefined;
  return `${outWidth}x${outHeight}`;
}

function closestLegacySize({ width, height }) {
  const target = Math.log(width / height);
  let best = LEGACY_SIZES[0];
  let bestDistance = Infinity;
  for (const [width, height] of LEGACY_SIZES) {
    const distance = Math.abs(Math.log(width / height) - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = [width, height];
    }
  }
  return `${best[0]}x${best[1]}`;
}

async function readReferenceDimensions(image) {
  if (!image) return undefined;
  if (image.kind === 'base64') return readImageSize(Buffer.from(image.payload, 'base64'));
  if (image.kind === 'url') return readRemoteImageHead(image.url);
  return undefined;
}

/**
 * CloudBase has no `aspect_ratio` field in either protocol: both only accept
 * a `${width}x${height}` `size` string. When the caller omits `size`, derive
 * the ratio from the first reference image and convert it into a size that
 * each protocol documents:
 *
 * messages -> one 1.5K-tier size (documented generate_max_pixels default)
 * legacy   -> one of the four documented sizes, closest ratio
 *
 * If the reference can't be read, return undefined and let CloudBase decide.
 */
async function deriveOutputSize(images, protocol) {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const dimensions = await readReferenceDimensions(images[0]);
  if (!dimensions?.width || !dimensions?.height) return undefined;
  return protocol === 'messages' ? fitMessagesSize(dimensions) : closestLegacySize(dimensions);
}

module.exports = {
  normalizeReferenceImages,
  readImageSize,
  deriveOutputSize,
};
