'use strict';

function readString(env, names, fallback = '') {
  for (const name of names) {
    if (env[name] !== undefined && env[name] !== '') {
      return String(env[name]).trim();
    }
  }
  return fallback;
}

function parseInteger(value, name, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseBoolean(value, name, fallback) {
  if (value === undefined || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean (true/false)`);
}

function parseBodySize(value) {
  const size = String(value || '32mb').trim().toLowerCase();
  if (!/^\d+(kb|mb)$/.test(size)) {
    throw new Error('MAX_BODY_SIZE must look like "512kb" or "32mb"');
  }
  return size;
}

function loadConfig(env = process.env) {
  const envId = readString(env, ['CLOUDBASE_ENV_ID', 'TCB_ENV']);
  if (!envId) {
    throw new Error('CLOUDBASE_ENV_ID is required');
  }

  const apiKey = readString(env, ['CLOUDBASE_APIKEY']);
  const secretId = readString(env, ['CLOUDBASE_SECRET_ID', 'TENCENTCLOUD_SECRETID']);
  const secretKey = readString(env, ['CLOUDBASE_SECRET_KEY', 'TENCENTCLOUD_SECRETKEY']);

  // Server-side credentials are optional: callers normally pass their own
  // CloudBase API Key as a Bearer token, and these values are only a fallback.

  return {
    envId,
    apiKey,
    secretId,
    secretKey,
    port: parseInteger(readString(env, ['PORT']), 'PORT', 8080, 1, 65535),
    upstreamTimeoutMs: parseInteger(
      readString(env, ['UPSTREAM_TIMEOUT_MS']),
      'UPSTREAM_TIMEOUT_MS',
      900000,
      10000,
      1800000,
    ),
    maxN: parseInteger(readString(env, ['MAX_N']), 'MAX_N', 10, 1, 50),
    revisePrompt: parseBoolean(readString(env, ['REVISE_PROMPT']), 'REVISE_PROMPT', true),
    b64DownloadTimeoutMs: parseInteger(
      readString(env, ['B64_DOWNLOAD_TIMEOUT_MS']),
      'B64_DOWNLOAD_TIMEOUT_MS',
      60000,
      1000,
      600000,
    ),
    maxB64Bytes: parseInteger(
      readString(env, ['MAX_B64_BYTES']),
      'MAX_B64_BYTES',
      20 * 1024 * 1024,
      1024,
      200 * 1024 * 1024,
    ),
    maxBodySize: parseBodySize(readString(env, ['MAX_BODY_SIZE'], '32mb')),
  };
}

module.exports = { loadConfig };
