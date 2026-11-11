import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../server.js';

let server;
let baseUrl;

before(async () => {
  server = createServer();
  // Port 0 = let the computer pick any free port.
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function getJson(pathAndQuery) {
  const response = await fetch(baseUrl + pathAndQuery);
  return { status: response.status, data: await response.json() };
}

test('GET /api/samples lists the samples', async () => {
  const { status, data } = await getJson('/api/samples');
  assert.equal(status, 200);
  assert.ok(data.samples.some((sample) => sample.id === 'published'));
});

test('GET /api/diagnose returns the raw response and a diagnosis for a sample', async () => {
  const { status, data } = await getJson('/api/diagnose?mode=sample&id=failed-unsupported-media');
  assert.equal(status, 200);
  assert.equal(data.mode, 'sample');
  assert.equal(data.sample.origin, 'docs-verbatim');
  assert.equal(data.raw.body.status, 'failed');
  assert.equal(data.diagnosis.outcome, 'failed');
  assert.equal(data.diagnosis.originalError, 'Unsupported media type');
});

test('sample mode is the default when no mode is given', async () => {
  const { status, data } = await getJson('/api/diagnose?id=published');
  assert.equal(status, 200);
  assert.equal(data.diagnosis.outcome, 'published');
});

test('an unknown sample id gives a 404 with the list of valid ids', async () => {
  const { status, data } = await getJson('/api/diagnose?mode=sample&id=nope');
  assert.equal(status, 404);
  assert.ok(data.availableSamples.includes('published'));
});

test('a missing id gives a 400', async () => {
  const { status } = await getJson('/api/diagnose?mode=sample');
  assert.equal(status, 400);
});

test('live mode says clearly that it is not built yet', async () => {
  const { status, data } = await getJson('/api/diagnose?mode=live&id=a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  assert.equal(status, 501);
  assert.match(data.error, /not built yet/);
});

test('the home page is served', async () => {
  const response = await fetch(baseUrl + '/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
});

test('files outside the public folder are never served', async () => {
  for (const path of ['/..%2Fpackage.json', '/%2e%2e/server.js', '/..%5Cserver.js']) {
    const response = await fetch(baseUrl + path);
    assert.equal(response.status, 404, path);
  }
});

test('requests other than GET are refused', async () => {
  const response = await fetch(baseUrl + '/api/samples', { method: 'POST' });
  assert.equal(response.status, 405);
});
