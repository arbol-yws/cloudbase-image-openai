'use strict';

const { ApiError } = require('./errors');

async function downloadAsBase64(url, config) {
  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(config.b64DownloadTimeoutMs),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new ApiError(
        504,
        `Downloading the generated image timed out after ${config.b64DownloadTimeoutMs} ms.`,
        { code: 'image_download_timeout' },
      );
    }
    throw new ApiError(502, `Failed to download the generated image: ${err.message}`, {
      code: 'image_download_failed',
    });
  }

  if (!response.ok) {
    throw new ApiError(
      502,
      `Failed to download the generated image: CloudBase returned HTTP ${response.status}.`,
      { code: 'image_download_failed' },
    );
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > config.maxB64Bytes) {
    throw new ApiError(
      502,
      `Generated image is larger than MAX_B64_BYTES (${config.maxB64Bytes} bytes). Increase the limit or use response_format=url.`,
      { code: 'image_too_large_for_b64' },
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > config.maxB64Bytes) {
    throw new ApiError(
      502,
      `Generated image is larger than MAX_B64_BYTES (${config.maxB64Bytes} bytes). Increase the limit or use response_format=url.`,
      { code: 'image_too_large_for_b64' },
    );
  }

  return buffer.toString('base64');
}

async function buildOpenAIResponse(results, plan, config) {
  const data = await Promise.all(
    results.map(async (result) => {
      if (plan.responseFormat === 'b64_json') {
        return { b64_json: await downloadAsBase64(result.url, config) };
      }
      return { url: result.url };
    }),
  );

  return {
    created: Math.floor(Date.now() / 1000),
    data,
  };
}

module.exports = { buildOpenAIResponse, downloadAsBase64 };
