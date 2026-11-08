'use strict';

/**
 * The two CloudBase image protocols. This is dispatch, not a model whitelist:
 * an unknown model name is still forwarded upstream.
 *
 *   messages: current hy-image family, provider "cloudbase", messages content
 *   legacy:   deprecated HY-Image family, provider "hunyuan-image", prompt payload
 *
 * The uppercase legacy identifiers (HY-Image-...) must not match the lowercase
 * prefix check.
 */
const MESSAGES_MODELS = new Set(['hy-image-v3.5-preview']);

function usesMessagesProtocol(model) {
  return MESSAGES_MODELS.has(model) || model.startsWith('hy-image-');
}

module.exports = { usesMessagesProtocol };
