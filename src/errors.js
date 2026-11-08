'use strict';

class ApiError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.type = statusCode === 401 || statusCode === 403
      ? 'authentication_error'
      : statusCode === 429
        ? 'rate_limit_error'
        : statusCode >= 500
          ? 'server_error'
          : 'invalid_request_error';
    this.param = options.param;
    this.code = options.code;
    // Logged by the error handler, never sent to the caller.
    this.upstream = options.upstream;
  }

  toJSON() {
    // Strict OpenAI error object. Diagnostics go to the server log only.
    return {
      error: {
        message: this.message,
        type: this.type,
        param: this.param ?? null,
        code: this.code,
      },
    };
  }
}

const SECRET_PATTERNS = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [
    /((?:secret[_-]?id|secret[_-]?key|access[_-]?key|api[_-]?key|apikey)\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    '$1[redacted]',
  ],
  [/\btcb-[A-Za-z0-9_-]{6,}\b/gi, 'tcb-[redacted]'],
];

function redactSecrets(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function truncate(value, limit = 4000) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}... [truncated]` : text;
}

const MESSAGE_TEXT_LIMIT = 800;

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) {
      return Array.isArray(value) ? value.join(', ') : String(value);
    }
  }
  return undefined;
}

/**
 * Pick the upstream code/message/request_id out of the captured body. Supports
 * the shapes CloudBase actually returns: `{ error: { code, message } }`,
 * `{ Response: { Error: { Code, Message }, RequestId } }`, and flat fields.
 */
function upstreamDetails(err, capture) {
  const last = capture?.last;
  const response = err?.response ?? err?.cause?.response;
  const json = plainObject(last?.body?.json) ?? plainObject(response?.data);
  const node = plainObject(json?.error)
    ?? plainObject(json?.Error)
    ?? plainObject(json?.Response?.Error)
    ?? json;
  const errCode = String(err?.code ?? '');

  return {
    code: firstText(
      node?.code,
      node?.Code,
      json?.code,
      json?.Code,
      /^\d{3}$/.test(errCode) ? undefined : errCode,
      err?.name === 'InvalidParamsError' ? 'INVALID_PARAMS' : undefined,
    ),
    message: firstText(
      node?.message,
      node?.Message,
      json?.message,
      json?.Message,
      json?.errMsg,
      err?.name === 'InvalidParamsError' ? err?.message : undefined,
      err?.message,
    ),
    request_id: firstText(
      last?.request_id,
      err?.requestId,
      headerValue(response?.headers, 'x-cloudbase-request-id'),
      headerValue(response?.headers, 'x-request-id'),
      json?.request_id,
      json?.RequestId,
      json?.error?.request_id,
    ),
    body: last?.body?.text
      ?? (response?.data !== undefined ? safeStringify(response.data) : null),
  };
}

/**
 * The caller-facing message carries both parts: `[adapter]` is this service's
 * summary, `[upstream]` is the original CloudBase status/code/message and its
 * request id. Everything is redacted and truncated.
 */
function buildUpstreamMessage(base, details = {}) {
  const parts = [`status ${details.status ?? 'unknown'}`];
  if (details.code) {
    parts.push(`code "${truncate(redactSecrets(details.code), 120)}"`);
  }
  if (details.message) {
    parts.push(`message "${truncate(redactSecrets(details.message), MESSAGE_TEXT_LIMIT)}"`);
  }
  if (!details.code && !details.message && details.body) {
    parts.push(`body "${truncate(redactSecrets(details.body), MESSAGE_TEXT_LIMIT)}"`);
  }
  parts.push(`request_id "${details.request_id ?? 'unknown'}"`);
  return `[adapter] ${base} [upstream] ${parts.join(', ')}.`;
}

function inferUpstreamStatus(err) {
  for (const value of [err?.statusCode, err?.status, err?.response?.status]) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 400 && parsed <= 599) return parsed;
  }
  const code = String(err?.code ?? '');
  if (/^\d{3}$/.test(code)) return Number(code);
  const match = String(err?.message ?? '').match(/status code\s+(\d{3})/i);
  return match ? Number(match[1]) : null;
}

function isTimeout(err, message) {
  return (
    ['ETIMEDOUT', 'ECONNABORTED', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ABORT_ERR'].includes(String(err?.code ?? ''))
    || /timeout|timed out|超时/i.test(message)
  );
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const out = { ...headers };
  for (const key of Object.keys(out)) {
    if (/authorization|cookie/i.test(key)) delete out[key];
    else out[key] = redactSecrets(out[key]);
  }
  return out;
}

/**
 * Turn one captured raw upstream response (or an axios-style response on the
 * error object) into a log-friendly record. Credentials are always redacted.
 */
function upstreamRecord(err, capture) {
  const last = capture?.last;
  const response = err?.response ?? err?.cause?.response;
  const body = last?.body?.text
    ?? (response?.data !== undefined ? safeStringify(response.data) : null);

  return {
    status: last?.statusCode ?? response?.status ?? inferUpstreamStatus(err),
    request_id: last?.request_id ?? err?.requestId ?? null,
    headers: sanitizeHeaders(last?.headers ?? response?.headers ?? null),
    body: body ? redactSecrets(truncate(body)) : null,
    body_available: Boolean(body),
  };
}

function safeStringify(value) {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Record a 2xx response that did not contain an image, using the same shape as
 * `upstreamRecord` so the error handler can log it the same way.
 */
function responseRecord(result, capture) {
  const last = capture?.last;
  const body = last?.body?.text ?? safeStringify(result);
  return {
    status: last?.statusCode ?? 200,
    request_id: last?.request_id ?? null,
    headers: sanitizeHeaders(last?.headers ?? null),
    body: body ? redactSecrets(truncate(body)) : null,
    body_available: Boolean(body),
  };
}

/**
 * Map a CloudBase SDK/network failure to an OpenAI-style error. The message
 * keeps the strict four-field shape and carries the upstream status/code/
 * message/request_id in plain text, so the caller can see why it was rejected
 * without reading server logs.
 */
function mapUpstreamError(err, context = {}) {
  if (err instanceof ApiError) return err;

  const status = inferUpstreamStatus(err);
  const upstream = upstreamRecord(err, context.capture);
  const details = upstreamDetails(err, context.capture);
  const text = upstream.body ?? String(err?.message ?? '');
  const message = (base) => buildUpstreamMessage(base, { ...details, status: upstream.status });

  if (isTimeout(err, text)) {
    return new ApiError(504, message('CloudBase image generation timed out.'), {
      code: 'upstream_timeout',
      upstream,
    });
  }
  if (status === 401 || status === 403) {
    return new ApiError(502, message('CloudBase rejected the request credential or environment permission.'), {
      code: 'upstream_authentication_error',
      upstream,
    });
  }
  if (status === 429) {
    return new ApiError(429, message('CloudBase rate limit exceeded.'), {
      code: 'rate_limit_exceeded',
      upstream,
    });
  }
  if (status === 422) {
    return new ApiError(400, message('CloudBase rejected the request during content moderation.'), {
      code: 'moderation_blocked',
      upstream,
    });
  }
  if (err?.name === 'InvalidParamsError' || String(err?.code ?? '') === 'INVALID_PARAMS') {
    return new ApiError(400, message('CloudBase rejected the request parameters.'), {
      param: err?.field,
      code: 'invalid_parameter',
      upstream,
    });
  }
  if (status === 400) {
    return new ApiError(400, message('CloudBase rejected the request with HTTP 400.'), {
      code: 'upstream_invalid_request',
      upstream,
    });
  }
  return new ApiError(502, message('CloudBase image generation failed.'), {
    code: 'upstream_error',
    upstream,
  });
}

module.exports = {
  ApiError,
  mapUpstreamError,
  buildUpstreamMessage,
  redactSecrets,
  inferUpstreamStatus,
  upstreamRecord,
  responseRecord,
};
