'use strict';

const { getModelSpec, buildModelMap } = require('./models');

const DEFAULT_MODEL = 'hy-image-v3.5-preview';

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

function parseModelMap(raw) {
  if (raw === undefined || raw === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('MODEL_MAP must be valid JSON, e.g. {"my-model":"hy-image-v3.5-preview"}');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MODEL_MAP must be a JSON object');
  }
  for (const [alias, target] of Object.entries(parsed)) {
    if (typeof target !== 'string' || !target.trim()) {
      throw new Error(`MODEL_MAP entry "${alias}" must be a non-empty string`);
    }
  }
  return parsed;
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

  if (!apiKey && !(secretId && secretKey)) {
    throw new Error(
      'CloudBase credentials are missing. Set CLOUDBASE_APIKEY, or set both CLOUDBASE_SECRET_ID and CLOUDBASE_SECRET_KEY',
    );
  }

  const modelMap = buildModelMap(parseModelMap(readString(env, ['MODEL_MAP'])));

  const defaultAlias = readString(env, ['DEFAULT_MODEL'], DEFAULT_MODEL);
  const defaultCanonical = modelMap[defaultAlias.toLowerCase()];
  if (!defaultCanonical || !getModelSpec(defaultCanonical)) {
    throw new Error(
      `DEFAULT_MODEL "${defaultAlias}" is not a supported CloudBase model. Supported: ${Object.keys(modelMap).sort().join(', ')}`,
    );
  }

  return {
    envId,
    apiKey,
    secretId,
    secretKey,
    port: parseInteger(readString(env, ['PORT']), 'PORT', 8080, 1, 65535),
    adapterApiKey: readString(env, ['ADAPTER_API_KEY']),
    defaultModel: defaultCanonical,
    modelMap,
    upstreamTimeoutMs: parseInteger(
      readString(env, ['UPSTREAM_TIMEOUT_MS']),
      'UPSTREAM_TIMEOUT_MS',
      900000,
      10000,
      1800000,
    ),
    maxN: parseInteger(readString(env, ['MAX_N']), 'MAX_N', 10, 1, 50),
    maxConcurrency: parseInteger(
      readString(env, ['MAX_CONCURRENCY']),
      'MAX_CONCURRENCY',
      3,
      1,
      20,
    ),
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
