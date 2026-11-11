// Live mode, tested against a FAKE Blotato server on this computer.
// These tests prove how this app behaves; they do not prove that the real
// Blotato API answers the way the docs describe (live mode is untested against it).

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createServer, LIVE_HEADER } from '../server.js';
import { isValidSubmissionId, redactKey } from '../lib/blotato-client.js';

const KEY = 'test-key-123==';
const ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ---------- Fake Blotato ----------

const upstreamRequests = [];
const FAKE_RESPONSES = {
  [ID]: [200, { postSubmissionId: ID, status: 'published', publicUrl: 'https://x.com/user/status/123456' }],
  'fail-1': [200, { postSubmissionId: 'fail-1', status: 'failed', errorMessage: 'Invalid account credentials' }],
  'forbid-1': [403, { code: 403, reqId: 'req-403', message: 'Forbidden access', subscriptionStatus: 'canceled', action: 'Renew the subscription.' }],
  'rate-1': [429, { message: 'Rate limit exceeded', reqId: 'req-429', action: 'Wait before sending more requests.' }],
  'echo-key': [200, { postSubmissionId: 'echo-key', status: 'failed', errorMessage: `Bad key ${KEY}` }],
};

const upstream = http.createServer((req, res) => {
  upstreamRequests.push({ method: req.method, url: req.url, key: req.headers['blotato-api-key'] });
  const id = decodeURIComponent(req.url.replace(/^\/v2\/posts\//, ''));
  if (id === 'html-1') {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    return res.end('<html><body>Bad gateway</body></html>');
  }
  const [status, body] = FAKE_RESPONSES[id] ?? [200, { postSubmissionId: id, status: 'in-progress' }];
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
});

// ---------- This app, pointed at the fake ----------

let clock = Date.parse('2026-11-11T10:00:00Z');
let apiKey = KEY;
let app;
let appUrl;

before(async () => {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  app = createServer({
    getApiKey: () => apiKey,
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v2`,
    now: () => clock,
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${app.address().port}`;
});

after(async () => {
  await new Promise((resolve) => app.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
});

async function liveCheck(id, headers = { [LIVE_HEADER]: '1' }) {
  const response = await fetch(`${appUrl}/api/diagnose?mode=live&id=${encodeURIComponent(id)}`, { headers });
  const text = await response.text();
  return { status: response.status, text, data: JSON.parse(text) };
}

const nextCheckAllowed = () => { clock += 10_000; };

// ---------- Tests ----------

test('a live check sends one GET to /v2/posts/:id with the blotato-api-key header', async () => {
  const before = upstreamRequests.length;
  const { status, data } = await liveCheck(ID);
  assert.equal(status, 200);
  assert.equal(upstreamRequests.length, before + 1);
  assert.deepEqual(upstreamRequests.at(-1), { method: 'GET', url: `/v2/posts/${ID}`, key: KEY });
  assert.equal(data.mode, 'live');
  assert.equal(data.raw.httpStatus, 200);
  assert.equal(data.diagnosis.outcome, 'published');
  assert.equal(data.diagnosis.facts.publicUrl, 'https://x.com/user/status/123456');
  nextCheckAllowed();
});

test('the API key never appears in what the browser receives', async () => {
  for (const id of [ID, 'fail-1', 'forbid-1', 'echo-key', 'html-1']) {
    const { text } = await liveCheck(id);
    assert.ok(!text.includes(KEY), `${id}: key leaked to the browser`);
    nextCheckAllowed();
  }
  const { text } = await liveCheck('echo-key');
  assert.match(text, /\[redacted\]/);
  nextCheckAllowed();
});

test('error bodies in the OpenAPI format reach the card', async () => {
  const forbidden = (await liveCheck('forbid-1')).data.diagnosis;
  assert.equal(forbidden.outcome, 'http-error');
  assert.equal(forbidden.originalError, 'Forbidden access');
  assert.equal(forbidden.apiRequestId, 'req-403');
  assert.equal(forbidden.apiSuggestedAction, 'Renew the subscription.');
  assert.equal(forbidden.apiSubscriptionStatus, 'canceled');
  assert.equal(forbidden.customerReply.kind, 'holding');
  nextCheckAllowed();

  const limited = (await liveCheck('rate-1')).data.diagnosis;
  assert.match(limited.headline, /429/);
  assert.equal(limited.apiRequestId, 'req-429');
  nextCheckAllowed();
});

test('a failed post is diagnosed with the catalog, using the requested ID', async () => {
  const { data } = await liveCheck('fail-1');
  assert.equal(data.diagnosis.catalogEntryId, 'account-invalid-credentials');
  assert.equal(data.diagnosis.facts.postSubmissionId, 'fail-1');
  nextCheckAllowed();
});

test('a response that is not JSON is reported, not guessed at', async () => {
  const { data } = await liveCheck('html-1');
  assert.equal(data.raw.httpStatus, 502);
  assert.equal(data.raw.bodyWasJson, false);
  assert.equal(data.diagnosis.outcome, 'http-error');
  assert.equal(data.diagnosis.checkCompleted, false);
  nextCheckAllowed();
});

test('the same ID cannot be checked again within 10 seconds', async () => {
  const id = 'throttle-1';
  const first = await liveCheck(id);
  assert.equal(first.status, 200);
  const sent = upstreamRequests.length;

  clock += 4_000;
  const tooSoon = await liveCheck(id);
  assert.equal(tooSoon.status, 429);
  assert.equal(tooSoon.data.retryAfterSeconds, 6);
  assert.match(tooSoon.data.error, /at least 10 seconds/);
  assert.equal(upstreamRequests.length, sent, 'no request may reach Blotato');

  const otherId = await liveCheck('throttle-2');
  assert.equal(otherId.status, 200, 'a different ID is not blocked');

  clock += 6_000;
  const afterWait = await liveCheck(id);
  assert.equal(afterWait.status, 200);
  nextCheckAllowed();
});

test('without an API key, live mode explains how to add one and calls nothing', async () => {
  const sent = upstreamRequests.length;
  apiKey = null;
  try {
    const { status, data } = await liveCheck('no-key-1');
    assert.equal(status, 503);
    assert.match(data.error, /BLOTATO_API_KEY/);
    assert.match(data.error, /\.env/);
  } finally {
    apiKey = KEY;
  }
  assert.equal(upstreamRequests.length, sent);
});

test('an ID with unexpected characters is refused before anything is sent', async () => {
  const sent = upstreamRequests.length;
  for (const id of ['../users/me', 'a b', 'x/y', 'a'.repeat(200)]) {
    const { status } = await liveCheck(id);
    assert.equal(status, 400, id);
  }
  assert.equal(upstreamRequests.length, sent);
});

test('live checks need the page header and a local Host', async () => {
  const sent = upstreamRequests.length;
  const noHeader = await liveCheck('guard-1', {});
  assert.equal(noHeader.status, 403);

  const foreignHost = await new Promise((resolve, reject) => {
    const req = http.request(`${appUrl}/api/diagnose?mode=live&id=guard-2`, {
      headers: { Host: 'evil.example', [LIVE_HEADER]: '1' },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(foreignHost, 403);
  assert.equal(upstreamRequests.length, sent);
});

test('when Blotato cannot be reached, the status is reported as unknown', async () => {
  const offline = createServer({
    getApiKey: () => KEY,
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  await new Promise((resolve) => offline.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${offline.address().port}/api/diagnose?mode=live&id=${ID}`, {
      headers: { [LIVE_HEADER]: '1' },
    });
    const data = await response.json();
    assert.equal(data.diagnosis.outcome, 'network-error');
    assert.equal(data.diagnosis.customerReply.kind, 'holding');
  } finally {
    await new Promise((resolve) => offline.close(resolve));
  }
});

test('live mode only ever sends GET requests to Blotato', () => {
  assert.ok(upstreamRequests.length > 5);
  assert.ok(upstreamRequests.every((request) => request.method === 'GET'));
  assert.ok(upstreamRequests.every((request) => request.url.startsWith('/v2/posts/')));
});

// ---------- Client helpers ----------

test('submission ID check accepts UUIDs and refuses path tricks', () => {
  assert.ok(isValidSubmissionId(ID));
  for (const bad of ['', '../x', 'a/b', 'a?b', 'a b', '%2e%2e', 'a'.repeat(129), null, 42]) {
    assert.equal(isValidSubmissionId(bad), false, String(bad));
  }
});

test('redactKey removes every copy of the key', () => {
  const out = redactKey({ a: `x ${KEY} y`, b: [KEY] }, KEY);
  assert.deepEqual(out, { a: 'x [redacted] y', b: ['[redacted]'] });
  assert.equal(redactKey(null, KEY), null);
});
