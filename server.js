// Small local web server for Blotato Post Doctor. No frameworks, only Node.js built-ins.
//
// Routes:
//   GET /api/samples                     -> list of built-in sample responses
//   GET /api/diagnose?mode=sample&id=... -> diagnosis for one sample
//   GET /api/diagnose?mode=live&id=...   -> not built yet (planned)
//   GET /api/drafts                      -> every customer reply draft, for review (see /drafts.html)
//   anything else                        -> static files from the /public folder
//
// Start it with:  npm start   (then open http://localhost:3000)

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { diagnose } from './lib/diagnose.js';
import { buildAllDrafts } from './lib/drafts.js';
import { getSample, listSamples } from './lib/samples.js';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, statusCode, data) {
  const text = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function handleDiagnose(url, res) {
  const mode = url.searchParams.get('mode') ?? 'sample';
  const id = (url.searchParams.get('id') ?? '').trim();

  if (mode !== 'sample' && mode !== 'live') {
    return sendJson(res, 400, { error: 'Unknown mode. Use mode=sample or mode=live.' });
  }
  if (id === '') {
    return sendJson(res, 400, { error: 'Missing "id". Add ?id=... to the address.' });
  }

  if (mode === 'live') {
    return sendJson(res, 501, {
      error: 'Live mode is not built yet. Switch to Sample mode for now.',
    });
  }

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

async function handleRequest(req, res) {
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
    return handleDiagnose(url, res);
  }
  if (url.pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'Unknown API address.' });
  }
  return serveStatic(url.pathname, res);
}

/** Creates the server without starting it (the tests use this). */
export function createServer() {
  return http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error('Unexpected server error:', error);
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
  // Read settings from .env if the file exists. It is fine if it does not.
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: use defaults.
  }

  const port = Number(process.env.PORT) || 3000;
  // 127.0.0.1 = this computer only. The app is not reachable from the network.
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Blotato Post Doctor is running at http://localhost:${port}`);
    console.log('Mode available: sample. Press Ctrl+C to stop.');
  });
}
