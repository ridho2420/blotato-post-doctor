// Small local web server for Blotato Post Doctor. No frameworks, only Node.js built-ins.
//
// Routes:
//   GET /api/samples                     -> list of built-in sample responses
//   GET /api/diagnose?mode=sample&id=... -> diagnosis for one sample
//   GET /api/diagnose?mode=live&id=...   -> checks a real post with the Blotato API (see below)
//   GET /api/drafts                      -> every customer reply draft, for review (see /drafts.html)
//   anything else                        -> static files from the /public folder
//
// Live mode rules (from the Blotato docs and the project brief):
//   - The API key is read from .env on this computer and never sent to the browser.
//   - One read-only status request per check. Nothing is ever created or resubmitted,
//     and nothing is polled automatically.
//   - At least 10 seconds between status checks of the same submission ID.
//
// Start it with:  npm start   (then open http://localhost:3000)

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { DEFAULT_BASE_URL, fetchPostStatus, isValidSubmissionId } from './lib/blotato-client.js';
import { diagnose } from './lib/diagnose.js';
import { buildAllDrafts } from './lib/drafts.js';
import { getSample, listSamples } from './lib/samples.js';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const ENV_FILE = fileURLToPath(new URL('./.env', import.meta.url));

// The docs ask for at least 10 seconds between status requests.
export const MIN_SECONDS_BETWEEN_CHECKS = 10;

// The page sends this header with live checks. Another website open in the same
// browser cannot add it without permission, so it cannot make this app spend the
// API key's requests.
export const LIVE_HEADER = 'x-post-doctor';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function sendJson(res, statusCode, data, extraHeaders = {}) {
  const text = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(text);
}

function hostnameOf(req) {
  try {
    return new URL(`http://${req.headers.host ?? ''}`).hostname;
  } catch {
    return '';
  }
}

function handleSample(id, res) {
  const sample = getSample(id);
  if (!sample) {
    return sendJson(res, 404, {
      error: `There is no sample called "${id}".`,
      availableSamples: listSamples().map((s) => s.id),
    });
  }
  const { response, ...sampleInfo } = sample;
  return sendJson(res, 200, {
    mode: 'sample',
    sample: sampleInfo,
    raw: response,
    diagnosis: diagnose(response),
  });
}

async function handleLive(id, req, res, live) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Live checks only accept GET requests.' });
  }
  if (!LOCAL_HOSTNAMES.has(hostnameOf(req)) || req.headers[LIVE_HEADER] !== '1') {
    return sendJson(res, 403, { error: 'Live checks can only be started from the Post Doctor page on this computer.' });
  }
  if (!isValidSubmissionId(id)) {
    return sendJson(res, 400, {
      error: 'That does not look like a submission ID. Paste the postSubmissionId exactly as it was returned when the post was created (letters, numbers, dashes, and underscores only).',
    });
  }
  const apiKey = live.getApiKey();
  if (!apiKey) {
    return sendJson(res, 503, {
      error: 'Live mode needs an API key. Add BLOTATO_API_KEY=... to the .env file in the project folder, then restart the app (npm start).',
    });
  }

  // At least 10 seconds between checks of the same submission ID. The time is
  // recorded before the request goes out, so a double click cannot send two.
  const now = live.now();
  const minMs = live.minSecondsBetweenChecks * 1000;
  for (const [checkedId, at] of live.lastCheckAt) {
    if (now - at >= minMs) live.lastCheckAt.delete(checkedId);
  }
  const last = live.lastCheckAt.get(id);
  if (last !== undefined) {
    const waitSeconds = Math.ceil((minMs - (now - last)) / 1000);
    return sendJson(res, 429, {
      error: `This post was checked less than ${live.minSecondsBetweenChecks} seconds ago. Blotato asks for at least ${live.minSecondsBetweenChecks} seconds between status checks. Try again in ${waitSeconds} second${waitSeconds === 1 ? '' : 's'}.`,
      retryAfterSeconds: waitSeconds,
    }, { 'Retry-After': String(waitSeconds) });
  }
  live.lastCheckAt.set(id, now);

  const result = await fetchPostStatus(id, {
    apiKey,
    baseUrl: live.baseUrl,
    fetchImpl: live.fetchImpl,
  });
  const diagnosis = result.networkError
    ? diagnose({ networkError: result.networkError }, { requestedId: id })
    : diagnose({ httpStatus: result.httpStatus, body: result.body }, { requestedId: id });

  return sendJson(res, 200, {
    mode: 'live',
    checkedAt: new Date(now).toISOString(),
    raw: result,
    diagnosis,
  });
}

function handleDiagnose(url, req, res, live) {
  const mode = url.searchParams.get('mode') ?? 'sample';
  const id = (url.searchParams.get('id') ?? '').trim();

  if (mode !== 'sample' && mode !== 'live') {
    return sendJson(res, 400, { error: 'Unknown mode. Use mode=sample or mode=live.' });
  }
  if (id === '') {
    return sendJson(res, 400, { error: 'Missing "id". Add ?id=... to the address.' });
  }
  return mode === 'live' ? handleLive(id, req, res, live) : handleSample(id, res);
}

async function serveStatic(pathname, res) {
  let relativePath;
  try {
    relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return sendJson(res, 404, { error: 'Not found.' });
  }
  const filePath = path.resolve(PUBLIC_DIR, relativePath);

  // Never serve anything outside the /public folder.
  if (!filePath.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
    return sendJson(res, 404, { error: 'Not found.' });
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'Not found.' });
  }
}

async function handleRequest(req, res, live) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Only GET requests are supported.' });
  }
  if (url.pathname === '/api/samples') {
    return sendJson(res, 200, { samples: listSamples() });
  }
  if (url.pathname === '/api/drafts') {
    return sendJson(res, 200, { drafts: buildAllDrafts() });
  }
  if (url.pathname === '/api/diagnose') {
    return handleDiagnose(url, req, res, live);
  }
  if (url.pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'Unknown API address.' });
  }
  return serveStatic(url.pathname, res);
}

/**
 * Creates the server without starting it (the tests use this).
 * The options exist so tests can point live mode at a fake Blotato server
 * and control the clock; normal use needs none of them.
 */
export function createServer(options = {}) {
  const live = {
    getApiKey: options.getApiKey ?? (() => process.env.BLOTATO_API_KEY?.trim() || null),
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? (() => Date.now()),
    minSecondsBetweenChecks: options.minSecondsBetweenChecks ?? MIN_SECONDS_BETWEEN_CHECKS,
    lastCheckAt: new Map(),
  };
  return http.createServer((req, res) => {
    handleRequest(req, res, live).catch((error) => {
      console.error('Unexpected server error:', error?.message ?? error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Unexpected server error. See the terminal for details.' });
      } else {
        res.end();
      }
    });
  });
}

// Start listening only when this file is run directly (npm start), not when a test imports it.
const runDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (runDirectly) {
  // Read settings from .env in the project folder if it exists. It is fine if it does not.
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // No .env file: sample mode only.
  }

  const port = Number(process.env.PORT) || 3000;
  const hasKey = Boolean(process.env.BLOTATO_API_KEY?.trim());
  // 127.0.0.1 = this computer only. The app is not reachable from the network.
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Blotato Post Doctor is running at http://localhost:${port}`);
    console.log(hasKey
      ? 'Sample mode and live mode are available (API key found in .env).'
      : 'Sample mode is available. Live mode is off: no BLOTATO_API_KEY in .env.');
    console.log('Press Ctrl+C to stop.');
  });
}
