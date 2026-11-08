'use strict';

class ApiError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.type = options.type || typeForStatus(statusCode);
    this.param = options.param;
    this.code = options.code || codeForStatus(statusCode);
  }

  toJSON() {
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

function typeForStatus(statusCode) {
  if (statusCode === 401 || statusCode === 403) return 'authentication_error';
  if (statusCode === 429) return 'rate_limit_error';
  if (statusCode >= 500) return 'server_error';
  return 'invalid_request_error';
}

function codeForStatus(statusCode) {
  switch (statusCode) {
    case 400:
      return 'invalid_request';
    case 401:
      return 'invalid_api_key';
    case 413:
      return 'request_too_large';
    case 429:
      return 'rate_limit_exceeded';
    case 504:
      return 'upstream_timeout';
    default:
      return statusCode >= 500 ? 'upstream_error' : 'invalid_request';
  }
}

function inferUpstreamStatus(err) {
  for (const value of [err?.statusCode, err?.status, err?.response?.status]) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 400 && parsed <= 599) return parsed;
  }

  const code = String(err?.code ?? '');
  if (/^\d{3}$/.test(code)) return Number(code);

  const message = String(err?.message ?? '');
  const match = message.match(/status code\s+(\d{3})/i);
  return match ? Number(match[1]) : null;
}

function isTimeout(err, message) {
  const code = String(err?.code ?? '');
  return (
    ['ETIMEDOUT', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'ABORT_ERR'].includes(code) ||
    /timeout|timed out|超时/i.test(message)
  );
}

function isAuthenticationFailure(status, message) {
  return (
    status === 401 ||
    status === 403 ||
    /credential|secretid|secretkey|api key|unauthorized|invalid.*token|鉴权|认证失败/i.test(message)
  );
}

function isRateLimit(status, message) {
  return (
    status === 429 ||
    /rate limit|too many requests|concurrency|concurrent|限流|频率|频繁/i.test(message)
  );
}

function isModerationFailure(status, code, message) {
  return (
    status === 422 ||
    /content audit|moderation|risk control|sensitive|审核|违规|内容安全/i.test(message) ||
    /audit|moderation|risk|content/i.test(code)
  );
}

function truncate(value, max = 600) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * Convert a CloudBase SDK/network error into an OpenAI-style ApiError.
 *
 * The Node SDK does not expose upstream status codes on its TcbError objects,
 * so the status is inferred from err.code, err.message ("status code 401") and
 * common auth/timeout/rate-limit signals.
 */
function mapUpstreamError(err, context = {}) {
  if (err instanceof ApiError) return err;

  const operation = context.operation || 'image generation';
  const status = inferUpstreamStatus(err);
  const code = String(err?.code ?? '');
  const message = truncate(err?.message ?? 'Unknown upstream error');
  const requestId = err?.requestId ? ` (CloudBase request_id: ${err.requestId})` : '';

  if (isTimeout(err, message)) {
    return new ApiError(504, `CloudBase ${operation} timed out.${requestId}`, {
      code: 'upstream_timeout',
    });
  }

  if (isAuthenticationFailure(status, message)) {
    return new ApiError(
      502,
      `CloudBase authentication failed while checking server credentials.${requestId} Upstream detail: ${message}`,
      { code: 'upstream_authentication_error' },
    );
  }

  if (isRateLimit(status, message)) {
    return new ApiError(429, `CloudBase rate limit exceeded.${requestId} Upstream detail: ${message}`, {
      code: 'rate_limit_exceeded',
    });
  }

  if (isModerationFailure(status, code, message)) {
    return new ApiError(400, `CloudBase rejected the request during content moderation.${requestId} Upstream detail: ${message}`, {
      code: 'moderation_blocked',
    });
  }

  if (err?.name === 'InvalidParamsError' || code === 'INVALID_PARAMS') {
    return new ApiError(400, `CloudBase rejected the request parameters.${requestId} Upstream detail: ${message}`, {
      param: err?.field,
      code: 'invalid_parameter',
    });
  }

  if (status === 400) {
    return new ApiError(400, `CloudBase rejected the request.${requestId} Upstream detail: ${message}`, {
      code: 'upstream_invalid_request',
    });
  }

  if (status === 429) {
    return new ApiError(429, `CloudBase rate limit exceeded.${requestId} Upstream detail: ${message}`, {
      code: 'rate_limit_exceeded',
    });
  }

  if (status === 401 || status === 403) {
    return new ApiError(
      502,
      `CloudBase authentication failed while checking server credentials.${requestId} Upstream detail: ${message}`,
      { code: 'upstream_authentication_error' },
    );
  }

  return new ApiError(502, `CloudBase ${operation} failed.${requestId} Upstream detail: ${message}`, {
    code: 'upstream_error',
  });
}

module.exports = {
  ApiError,
  mapUpstreamError,
  inferUpstreamStatus,
};
