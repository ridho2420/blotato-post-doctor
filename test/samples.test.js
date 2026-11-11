import test from 'node:test';
import assert from 'node:assert/strict';

import { diagnose } from '../lib/diagnose.js';
import { getSample, listSamples, SAMPLE_ORIGINS } from '../lib/samples.js';

const NOW = new Date('2026-11-11T00:00:00Z');

test('all sample files load and say where they came from', () => {
  const samples = listSamples();
  assert.ok(samples.length >= 4);
  for (const sample of samples) {
    assert.ok(SAMPLE_ORIGINS.includes(sample.origin), `${sample.id}: origin`);
    assert.ok(sample.note.length > 20, `${sample.id}: note`);
  }
});

test('the four documented statuses each have a sample copied from the docs', () => {
  const expected = {
    'published': 'published',
    'scheduled': 'scheduled',
    'in-progress': 'in-progress',
    'failed-unsupported-media': 'failed',
  };
  for (const [id, status] of Object.entries(expected)) {
    const sample = getSample(id);
    assert.ok(sample, `missing sample ${id}`);
    assert.equal(sample.origin, 'docs-verbatim');
    assert.equal(sample.response.body.status, status);
  }
});

test('getSample returns null for an unknown id', () => {
  assert.equal(getSample('does-not-exist'), null);
});

test('every sample produces a complete diagnosis', () => {
  for (const { id } of listSamples()) {
    const d = diagnose(getSample(id).response, { now: NOW });
    assert.ok(d.headline, `${id}: headline`);
    assert.ok(d.whatHappened, `${id}: whatHappened`);
    assert.ok(d.agentSteps.length > 0, `${id}: nextSteps`);
    assert.ok(d.customerReply.text.length > 50, `${id}: customerReply`);
  }
});

test('samples lead to the outcome their name promises', () => {
  const outcomeOf = (id) => diagnose(getSample(id).response, { now: NOW });
  assert.equal(outcomeOf('failed-account-not-authorized').catalogEntryId, 'account-not-authorized-meta');
  assert.equal(outcomeOf('failed-video-too-long').catalogEntryId, 'media-video-too-long-to-convert');
  assert.equal(outcomeOf('failed-duplicate-tweet').catalogEntryId, 'x-duplicate-content');
  assert.equal(outcomeOf('failed-unrecognized').recognized, false);
  assert.equal(outcomeOf('scheduled').tone, 'info');
  assert.equal(outcomeOf('scheduled-past').tone, 'warning');
  assert.equal(outcomeOf('http-401').outcome, 'http-error');
  assert.equal(outcomeOf('http-429').outcome, 'http-error');
});
