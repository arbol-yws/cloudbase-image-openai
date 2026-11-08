'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * One mechanism for evidence: capture the raw upstream response at the SDK
 * transport boundary and log it. Nothing is added to the OpenAI response
 * structure.
 *
 * The SDK's AI request adapter throws a TcbError that only keeps
 * { code, message, requestId }, and it drops the response body because the
 * transport already parsed it into an object. Wrapping the common OpenAPI
 * requester gives us the original { statusCode, headers, body }.
 */

const storage = new AsyncLocalStorage();
let patchState = { patched: false, reason: null };

function getContext() {
  return storage.getStore();
}

function runWithContext(context, fn) {
  return storage.run(context, fn);
}

function createCapture() {
  return { last: null };
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) out[key] = value.join(', ');
    else if (value !== undefined) out[key] = String(value);
  }
  return out;
}

function serializeBody(body) {
  if (body === undefined || body === null) return { text: null, json: null };
  if (typeof body === 'string') {
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }
    return { text: body, json };
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    const text = Buffer.from(body).toString('utf8');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { text, json };
  }
  if (typeof body === 'object') {
    if (typeof body.on === 'function') return { text: null, json: null };
    let text = null;
    try {
      text = JSON.stringify(body);
    } catch {
      text = null;
    }
    return { text, json: body };
  }
  return { text: String(body), json: null };
}

function recordResponse(result, args, capture = getContext()) {
  if (!capture || !result) return;
  const statusCode = Number(result.statusCode);
  if (!Number.isInteger(statusCode) || statusCode < 400) return;

  const headers = normalizeHeaders(result.headers);
  capture.last = {
    statusCode,
    method: args?.method ?? null,
    url: args?.url ?? null,
    request_id: headers?.['x-cloudbase-request-id'] ?? headers?.['x-request-id'] ?? null,
    headers,
    body: serializeBody(result.body),
  };
}

function installPatch() {
  let requester;
  try {
    requester = require('@cloudbase/node-sdk/dist/utils/tcbopenapicommonrequester');
  } catch (err) {
    patchState = { patched: false, reason: `cannot load SDK requester module: ${err.message}` };
    return;
  }

  if (typeof requester.request !== 'function') {
    patchState = { patched: false, reason: 'SDK requester module does not export request()' };
    return;
  }
  if (requester.__adapterCaptureInstalled) {
    patchState = { patched: true, reason: 'already installed' };
    return;
  }

  const original = requester.request;
  requester.request = async function requestWithCapture(args) {
    const result = await original.call(this, args);
    recordResponse(result, args);
    return result;
  };
  requester.__adapterCaptureInstalled = true;
  patchState = { patched: true, reason: 'installed' };
}

installPatch();

function getPatchState() {
  return { ...patchState };
}

module.exports = {
  createCapture,
  runWithContext,
  getContext,
  recordResponse,
  serializeBody,
  getPatchState,
};
