'use strict';

const MB = 1024 * 1024;

/**
 * Protocol capability rules.
 *
 * These are NOT a model whitelist: model names are forwarded to CloudBase
 * verbatim. Only the wire protocol differs between the two CloudBase SDK
 * providers, so each protocol declares the constraints that belong to the
 * endpoint itself.
 *
 * messages: cloudbase provider, Chat/Messages payload, current Hy-Image family
 * legacy:   hunyuan-image provider, prompt/image_urls payload, old HY-Image family
 */
const PROTOCOLS = Object.freeze({
  messages: Object.freeze({
    protocol: 'messages',
    provider: 'cloudbase',
    maxImages: 20,
    maxImageBytes: 20 * MB,
    allowedImageMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
    supportsSession: true,
    supportsRevise: false,
    supportsGenerateMaxPixels: true,
    supportsResizeMaxPixels: true,
    supportsSearchTool: true,
  }),
  legacy: Object.freeze({
    protocol: 'legacy',
    provider: 'hunyuan-image',
    maxImages: 1,
    maxImageBytes: 10 * MB,
    allowedImageMimeTypes: ['image/png', 'image/jpeg'],
    supportsSession: false,
    supportsRevise: true,
    supportsGenerateMaxPixels: false,
    supportsResizeMaxPixels: false,
    supportsSearchTool: false,
  }),
});

/**
 * Dispatch a model name to its CloudBase wire protocol.
 *
 * Rule: model names that start with the lowercase prefix "hy-image-" use the
 * Chat/Messages protocol (cloudbase provider); every other model name, including
 * the uppercase legacy family "HY-Image-...", uses the classic
 * prompt/image_urls protocol (hunyuan-image provider). The comparison is
 * case-sensitive on purpose, so legacy identifiers are not swept into the
 * Messages branch. This is protocol dispatch, not validation: unknown names
 * are still forwarded upstream.
 */
function resolveProtocol(model) {
  return model.startsWith('hy-image-') ? 'messages' : 'legacy';
}

function getProtocolSpec(protocol) {
  return PROTOCOLS[protocol];
}

module.exports = { PROTOCOLS, resolveProtocol, getProtocolSpec };
