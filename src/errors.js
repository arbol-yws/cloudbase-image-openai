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
  // Skip HTTP status codes and transport-level codes (ETIMEDOUT, ERR_BAD_REQUEST...).
  const skipErrCode = /^\d{3}$/.test(errCode)
    || /^(E[A-Z]+|ERR_[A-Z_]+|UND_ERR_[A-Z_]+|ABORT_ERR)$/.test(errCode);

  return {
    code: firstText(node?.code, node?.Code, json?.code, json?.Code),
    message: firstText(
      node?.message,
      node?.Message,
      json?.message,
      json?.Message,
      json?.errMsg,
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
    body_json: Boolean(json),
    err_name: err?.name,
    err_message: err?.message,
    err_code: errCode && !skipErrCode ? errCode : undefined,
  };
}

/**
 * Return the upstream's own error text: its message, otherwise its code,
 * otherwise the raw body. No prefixes, status or request id are appended.
 */
function upstreamErrorText(details) {
  const explicit = firstText(details.message, details.code);
  if (explicit) return truncate(redactSecrets(explicit), MESSAGE_TEXT_LIMIT);
  if (!details.body_json && details.body && details.body.trim()) {
    return truncate(redactSecrets(details.body), MESSAGE_TEXT_LIMIT);
  }
  if (details.err_name === 'InvalidParamsError' && details.err_message) {
    return truncate(redactSecrets(details.err_message), MESSAGE_TEXT_LIMIT);
  }
  if (details.err_code) return truncate(redactSecrets(details.err_code), MESSAGE_TEXT_LIMIT);
  return undefined;
}

function missingUpstreamMessage(status) {
  return `CloudBase returned HTTP ${status ?? 'unknown'} without an error message.`;
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
 * Map a CloudBase SDK/network failure to an OpenAI-style error. The message is
 * the upstream's own text when there is one; otherwise a short adapter note.
 * Keep the strict four-field shape and the truncation/redaction above.
 */
function mapUpstreamError(err, context = {}) {
  if (err instanceof ApiError) return err;

  const status = inferUpstreamStatus(err);
  const upstream = upstreamRecord(err, context.capture);
  const details = upstreamDetails(err, context.capture);
  const text = upstream.body ?? String(err?.message ?? '');
  const upstreamStatus = upstream.status ?? status;
  const explicit = upstreamErrorText(details);
  const message = (fallback) => explicit ?? fallback;

  if (isTimeout(err, text)) {
    return new ApiError(504, message('CloudBase image generation timed out.'), {
      code: 'upstream_timeout',
      upstream,
    });
  }
  if (status === 401 || status === 403) {
    return new ApiError(502, message(missingUpstreamMessage(upstreamStatus)), {
      code: 'upstream_authentication_error',
      upstream,
    });
  }
  if (status === 429) {
    return new ApiError(429, message(missingUpstreamMessage(upstreamStatus)), {
      code: 'rate_limit_exceeded',
      upstream,
    });
  }
  if (status === 422) {
    return new ApiError(400, message(missingUpstreamMessage(upstreamStatus)), {
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
    return new ApiError(400, message(missingUpstreamMessage(upstreamStatus)), {
      code: 'upstream_invalid_request',
      upstream,
    });
  }
  return new ApiError(502, message(missingUpstreamMessage(upstreamStatus)), {
    code: 'upstream_error',
    upstream,
  });
}

module.exports = {
  ApiError,
  mapUpstreamError,
  redactSecrets,
  inferUpstreamStatus,
  upstreamRecord,
  responseRecord,
};
