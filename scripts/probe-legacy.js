'use strict';

/**
 * Raw HTTP probe for the legacy CloudBase image endpoint.
 *
 * It does NOT use the SDK to send the request. It only uses the SDK once to
 * derive the real gateway base URL:
 *
 *   ai.baseUrl = `${env}.api.tcloudbasegateway.com/v1/ai`
 *   legacy image endpoint = `${ai.baseUrl}/hunyuan-image/images/ar/generations`
 *
 * Source: @cloudbase/node-sdk `dist/utils/tcbopenapiendpoint.js` (gateway URL)
 * plus @cloudbase/ai `src/models/image-model.ts`
 * (`defaultGenerateImageSubUrl = 'images/ar/generations'` and
 * `getGenerateUrl() = `${baseUrl}/${provider}/${subUrl}``).
 *
 * The probe prints the status line, every response header, and the raw response
 * body so you can tell whether the 400 comes from the request fields, the model,
 * or the credential. Each request shape is sent at most once.
 *
 * Usage:
 *   node scripts/probe-legacy.js \
 *     --env <env-id> \
 *     --key <CloudBase API Key> \
 *     [--model HY-Image-v3.0-I2I-ToB-v1.0.1] \
 *     [--text-model HY-Image-3.0-Plus-4090-Tob-v1.0] \
 *     [--image-url https://example.com/reference.png] \
 *     [--image-file ./reference.png] \
 *     [--size 1024x1024] \
 *     [--shapes image_urls,images,prompt-only] \
 *     [--endpoint https://.../v1/ai/hunyuan-image/images/ar/generations]
 *
 * The key is read from --key or CLOUDBASE_APIKEY and is never printed.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const tcb = require('@cloudbase/node-sdk');

const SDK_VERSION = require('@cloudbase/node-sdk/package.json').version;

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[name] = next;
      i += 1;
    } else {
      args[name] = true;
    }
  }
  return args;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function redact(value, secret) {
  let text = String(value ?? '');
  if (secret) text = text.split(secret).join('[redacted]');
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /((?:secret[_-]?id|secret[_-]?key|access[_-]?key|api[_-]?key|apikey)\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
      '$1[redacted]',
    )
    .replace(/\btcb-[A-Za-z0-9_-]{6,}\b/gi, 'tcb-[redacted]');
}

function readBase64Image(args) {
  if (args['image-file']) {
    const file = path.resolve(String(args['image-file']));
    const buffer = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return {
      base64: buffer.toString('base64'),
      bytes: buffer.length,
      mime,
      source: file,
    };
  }
  if (args['image-base64']) {
    return {
      base64: String(args['image-base64']).replace(/\s+/g, ''),
      bytes: Buffer.from(String(args['image-base64']).replace(/\s+/g, ''), 'base64').length,
      mime: 'image/png',
      source: '--image-base64',
    };
  }
  return {
    base64: TINY_PNG_BASE64,
    bytes: Buffer.from(TINY_PNG_BASE64, 'base64').length,
    mime: 'image/png',
    source: 'built-in 1x1 PNG',
  };
}

function postJson(urlString, payload, key) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlString);
    const body = Buffer.from(JSON.stringify(payload));
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          authorization: `Bearer ${key}`,
          'x-client-timestamp': String(Math.floor(Date.now() / 1000)),
          'x-sdk-version': `tcb-node-sdk/${SDK_VERSION}`,
          'x-tcb-source': 'probe-legacy',
        },
        timeout: 600000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('probe request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function printResponse(label, result, key) {
  const text = result.body.toString('utf8');
  console.log(`\n--- ${label} ---`);
  console.log(`status: ${result.statusCode}`);
  console.log('headers:');
  for (const [name, value] of Object.entries(result.headers)) {
    if (/authorization|cookie/i.test(name)) continue;
    console.log(`  ${name}: ${redact(Array.isArray(value) ? value.join(', ') : value, key)}`);
  }
  console.log(`raw_body_bytes: ${result.body.length}`);
  console.log(`raw_body_utf8:`);
  console.log(redact(text || '(empty body)', key));

  if (text.length > 0 && !/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text)) {
    console.log(`raw_body_hex_first_512: ${result.body.subarray(0, 512).toString('hex')}`);
  }

  try {
    const parsed = JSON.parse(text);
    console.log(`parsed_json: ${redact(JSON.stringify(parsed), key)}`);
  } catch {
    console.log('parsed_json: (body is not valid JSON)');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/probe-legacy.js --env <env-id> --key <key> [--model ...] [--image-url ...] [--image-file ...] [--size ...] [--shapes image_urls,images,prompt-only]');
    return 0;
  }

  const env = String(args.env || process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV || '').trim();
  const key = String(args.key || process.env.CLOUDBASE_APIKEY || '').trim();
  const keySource = args.key ? '--key' : process.env.CLOUDBASE_APIKEY ? 'CLOUDBASE_APIKEY' : 'none';

  if (!env) {
    console.error('Missing environment id. Pass --env <env-id> or set CLOUDBASE_ENV_ID.');
    return 2;
  }
  if (!key) {
    console.error('Missing API key. Pass --key <key> or set CLOUDBASE_APIKEY.');
    return 2;
  }

  const model = String(args.model || 'HY-Image-v3.0-I2I-ToB-v1.0.1');
  const textModel = String(args['text-model'] || 'HY-Image-3.0-Plus-4090-Tob-v1.0');
  const size = args.size ? String(args.size) : null;
  const image = readBase64Image(args);
  const imageUrl = String(args['image-url'] || '');
  const shapes = String(args.shapes || 'image_urls,images,prompt-only')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  // Derive the real gateway URL from the SDK. No network call is made here.
  const app = tcb.init({ env, accessKey: key, timeout: Number(args.timeout || 600000) });
  const ai = app.ai();
  const derivedEndpoint = `${ai.baseUrl}/hunyuan-image/images/ar/generations`;
  const endpoint = String(args.endpoint || derivedEndpoint);

  console.log('== legacy image endpoint probe ==');
  console.log(`env: ${env}`);
  console.log(`key source: ${keySource}`);
  console.log(`key length: ${key.length}`);
  console.log(`key sha256 fingerprint: ${fingerprint(key)}`);
  console.log(`sdk: @cloudbase/node-sdk ${SDK_VERSION}`);
  console.log(`endpoint: ${endpoint}`);
  console.log(`endpoint source: ${args.endpoint ? '--endpoint override' : 'ai.baseUrl + /hunyuan-image/ + SDK default subUrl images/ar/generations'}`);
  console.log(`model: ${model}`);
  console.log(`text model: ${textModel}`);
  console.log(`size: ${size || '(not set; upstream default)'}`);
  console.log(`image: ${image.source}, ${image.bytes} bytes, ${image.mime}, base64 length ${image.base64.length}`);
  console.log(`shapes: ${shapes.join(', ')}`);
  console.log('note: each shape is sent at most once.');

  let calls = 0;

  async function runShape(label, payload) {
    calls += 1;
    console.log(`\n>>> ${label} (call ${calls})`);
    console.log(`request body (base64 truncated): ${redact(JSON.stringify(payload, (keyName, value) => (
      typeof value === 'string' && value.length > 120 ? `${value.slice(0, 60)}...(${value.length} chars)` : value
    )), key)}`);
    try {
      const result = await postJson(endpoint, payload, key);
      printResponse(label, result, key);
    } catch (err) {
      console.log(`\n--- ${label} ---`);
      console.log(`network_error: ${redact(err.message, key)}`);
    }
  }

  if (shapes.includes('image_urls')) {
    if (!imageUrl) {
      console.log('\n>>> image_urls (skipped: pass --image-url <public URL> to run this shape)');
    } else {
      const payload = { model, prompt: args.prompt || '将这张照片转换为油画风格', image_urls: [imageUrl] };
      if (size) payload.size = size;
      await runShape('image_urls (URL reference)', payload);
    }
  }

  if (shapes.includes('images')) {
    const payload = { model, prompt: args.prompt || '将这张照片转换为油画风格', images: [image.base64] };
    if (size) payload.size = size;
    await runShape('images (base64 reference)', payload);
  }

  if (shapes.includes('prompt-only')) {
    const payload = { model: textModel, prompt: args.prompt || '一只在窗台上打盹的橘猫，水彩风格' };
    if (size) payload.size = size;
    await runShape('prompt-only (text-to-image)', payload);
  }

  console.log(`\ncalls_made: ${calls}`);
  console.log('interpretation:');
  console.log('  - 200 for prompt-only but 400 for reference shapes -> request-field/model issue, not credential.');
  console.log('  - 200 for one reference shape but 400 for the other -> field name (image_urls vs images) issue.');
  console.log('  - 401/403 for every shape -> credential or environment permission issue.');
  console.log('  - 400 body contains a field name -> compare that field with the request body printed above.');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`probe failed: ${redact(err?.message || err, process.env.CLOUDBASE_APIKEY)}`);
    process.exitCode = 1;
  });
