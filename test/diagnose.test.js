import test from 'node:test';
import assert from 'node:assert/strict';

import { catalog, diagnose, formatUtc, matchError } from '../lib/diagnose.js';

const ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const NOW = new Date('2026-11-11T00:00:00Z');
const ok = (body) => ({ httpStatus: 200, body });

// ---------- The four documented statuses ----------

test('published with a public URL', () => {
  const d = diagnose(ok({ postSubmissionId: ID, status: 'published', publicUrl: 'https://x.com/user/status/123456' }));
  assert.equal(d.outcome, 'published');
  assert.equal(d.tone, 'success');
  assert.equal(d.facts.publicUrl, 'https://x.com/user/status/123456');
  assert.match(d.whatHappened, /x\.com\/user\/status\/123456/);
});

test('published without a public URL does not invent one', () => {
  const d = diagnose(ok({ postSubmissionId: ID, status: 'published' }));
  assert.equal(d.outcome, 'published');
  assert.equal(d.facts.publicUrl, null);
  assert.match(d.whatHappened, /did not return a public URL/);
});

test('a publicUrl that is not a web address is ignored', () => {
  const d = diagnose(ok({ postSubmissionId: ID, status: 'published', publicUrl: 'javascript:alert(1)' }));
  assert.equal(d.facts.publicUrl, null);
});

test('scheduled in the future is reported as scheduled, never as published', () => {
  const d = diagnose(ok({ postSubmissionId: ID, status: 'scheduled', scheduledTime: '2030-06-15T15:00:00Z' }), { now: NOW });
  assert.equal(d.outcome, 'scheduled');
  assert.equal(d.tone, 'info');
  assert.match(d.whatHappened, /June 15, 2030, 15:00 UTC/);
  assert.match(d.whatHappened, /not been published yet/);
});

test('scheduled with a time in the past is flagged, without guessing why', () => {
  const d = diagnose(ok({ postSubmissionId: ID, status: 'scheduled', scheduledTime: '2025-03-10T15:30:00Z' }), { now: NOW });
  assert.equal(d.outcome, 'scheduled');
  assert.equal(d.tone, 'warning');
  assert.match(d.whatHappened, /already passed/);
  assert.equal(d.why, null);
  assert.match(d.caveat, /will not guess/);
});

test('scheduled without a readable time still says it is not published', () => {
  const d = diagnose(ok({ postSubmissionId: ID, status: 'scheduled', scheduledTime: 'not a date' }), { now: NOW });
  assert.equal(d.outcome, 'scheduled');
  assert.match(d.whatHappened, /did not include a readable scheduled time/);
});

test('in-progress warns that the ID is not proven valid and that resubmitting risks a duplicate', () => {
  const d = diagnose(ok({ postSubmissionId: ID, status: 'in-progress' }));
  assert.equal(d.outcome, 'in-progress');
  assert.equal(d.tone, 'waiting');
  assert.match(d.caveat, /does not prove the ID is valid/);
  assert.ok(d.nextSteps.some((step) => /at least 10 seconds/.test(step)));
  assert.ok(d.nextSteps.some((step) => /duplicate/.test(step)));
});

// ---------- Failed posts ----------

test('failed with a known error gives the catalog explanation and keeps the original text', () => {
  const d = diagnose(ok({ postSubmissionId: ID, status: 'failed', errorMessage: 'Unsupported media type' }));
  assert.equal(d.outcome, 'failed');
  assert.equal(d.recognized, true);
  assert.equal(d.category, 'media');
  assert.equal(d.catalogEntryId, 'media-unsupported-type');
  assert.equal(d.originalError, 'Unsupported media type');
  assert.ok(d.why);
  assert.ok(d.nextSteps.length > 0);
});

test('failed with an unknown error shows the original text and does not guess a cause', () => {
  const message = 'Example error text that is not in the catalog (ref: demo-0001)';
  const d = diagnose(ok({ postSubmissionId: ID, status: 'failed', errorMessage: message }));
  assert.equal(d.outcome, 'failed');
  assert.equal(d.recognized, false);
  assert.equal(d.originalError, message);
  assert.equal(d.why, null);
  assert.equal(d.category, null);
  assert.equal(d.catalogEntryId, null);
  assert.match(d.caveat, /not in this tool's catalog/);
  assert.match(d.caveat, /will not guess/);
  assert.match(d.supportReply, /demo-0001/);
  assert.doesNotMatch(d.supportReply, /Why:/);
});

test('failed without any errorMessage does not guess a cause', () => {
  const d = diagnose(ok({ postSubmissionId: ID, status: 'failed' }));
  assert.equal(d.recognized, false);
  assert.equal(d.why, null);
  assert.equal(d.originalError, null);
});

test('error matching ignores upper/lower case, curly apostrophes, and extra spaces', () => {
  assert.equal(matchError('UNSUPPORTED   MEDIA TYPE').id, 'media-unsupported-type');
  assert.equal(
    matchError('TikTok’s servers may be experiencing issues. This is a retryable error').id,
    'tiktok-retryable-server-issue',
  );
  assert.equal(matchError('something nobody has seen before'), null);
  assert.equal(matchError(''), null);
  assert.equal(matchError(undefined), null);
});

test('specific catalog entries win over general ones', () => {
  assert.equal(
    matchError('Unsupported media format: mov,mp4,m4a,3gp,3g2,mj2').id,
    'media-container-not-recognized',
  );
  assert.equal(
    matchError('This video is 185 seconds long, but we can only automatically fix videos up to 120 seconds').id,
    'media-video-too-long-to-convert',
  );
  assert.equal(
    matchError('You have reached the maximum number of 25 posts for the last 24 hours for this account').id,
    'posting-limit-24h',
  );
});

test('every catalog entry is complete and has a unique id', () => {
  const ids = new Set();
  for (const entry of catalog.entries) {
    assert.ok(entry.id, 'entry needs an id');
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
    ids.add(entry.id);
    const patterns = entry.matchAny ?? [];
    assert.ok(patterns.length > 0 || entry.matchRegex, `${entry.id}: needs matchAny or matchRegex`);
    assert.ok(patterns.every((m) => typeof m === 'string' && m.trim().length >= 10), `${entry.id}: patterns must be specific`);
    if (entry.matchRegex) assert.doesNotThrow(() => new RegExp(entry.matchRegex, 'i'), `${entry.id}: matchRegex`);
    assert.ok(entry.category, `${entry.id}: category`);
    assert.ok(entry.title, `${entry.id}: title`);
    assert.ok(entry.why, `${entry.id}: why`);
    assert.ok(Array.isArray(entry.nextSteps) && entry.nextSteps.length > 0, `${entry.id}: nextSteps`);
    assert.ok((entry.links ?? []).every((l) => l.label && l.url.startsWith('https://')), `${entry.id}: links`);
  }
});

test('each entry is reachable: its own patterns are not swallowed by an earlier entry', () => {
  for (const entry of catalog.entries) {
    for (const pattern of entry.matchAny ?? []) {
      assert.equal(matchError(`Some prefix: ${pattern} (ref 123)`).id, entry.id, `"${pattern}" should lead to ${entry.id}`);
    }
  }
});

test('error texts quoted in the Error Reference lead to the right entry', () => {
  const cases = {
    'Account 98432 not found': 'account-not-found',
    'Could not upload media to Twitter': 'media-rejected-by-platform',
    'Could not upload media to storage': 'media-not-reachable',
    'Could not upload video to Facebook: Please reduce the amount of data you’re asking for, then retry your request': 'facebook-reduce-data',
    'Post failed to publish. Could not upload video': 'video-upload-failed',
    'Unsupported media format (.mov)': 'media-unsupported-format',
    'Cannot read properties of undefined (reading \'mediaUrl\')': 'media-result-missing',
    'Cannot read properties of undefined (reading \'status\')': 'platform-no-response',
    'You have reached the maximum number of 3 unique accounts for the last 24 hours. Please upgrade your plan to add more.': 'tiktok-unique-accounts-limit',
    'Text length exceeds the character limit of 280 characters for platform twitter': 'text-too-long',
    'Error posting to Facebook: (#200) requires pages_read_engagement and pages_manage_posts permission': 'facebook-missing-page-permissions',
    "body.post.target must have required property 'isYourBrand' or 'isBrandedContent'": 'tiktok-brand-fields-missing',
    'Failed to publish TikTok post after 3 retries (Unknown error reason)': 'tiktok-retries-exhausted',
    'Slack did not confirm the post. It may have been posted.': 'slack-not-confirmed',
    'This Slack channel is archived.': 'slack-channel-archived',
    'Instagram rejected your post': 'instagram-rejected-post',
    'Could not schedule post: No available slot time found in the next 9 months': 'no-free-slot',
  };
  for (const [message, expectedId] of Object.entries(cases)) {
    assert.equal(matchError(message)?.id, expectedId, message);
  }
});

// ---------- Problems with the check itself ----------

test('HTTP 401 explains the API key problem and says the post status is unknown', () => {
  const d = diagnose({ httpStatus: 401, body: null });
  assert.equal(d.outcome, 'http-error');
  assert.equal(d.checkCompleted, false);
  assert.match(d.headline, /401/);
  assert.match(d.whatHappened, /nothing is known about the post/);
});

test('HTTP 429 keeps the API message and does not call the post failed', () => {
  const d = diagnose({ httpStatus: 429, body: { statusCode: 429, message: 'Rate limit exceeded, retry in 49 seconds' } });
  assert.equal(d.outcome, 'http-error');
  assert.equal(d.originalError, 'Rate limit exceeded, retry in 49 seconds');
  assert.match(d.why, /60 requests per minute/);
  assert.match(d.caveat, /says nothing about whether the post itself/);
});

test('HTTP 500 says a status check is safe to repeat but the post must not be resubmitted', () => {
  const d = diagnose({ httpStatus: 503, body: null });
  assert.match(d.headline, /503/);
  assert.ok(d.nextSteps.some((step) => /repeating it is safe/.test(step)));
  assert.ok(d.nextSteps.some((step) => /duplicate/.test(step)));
});

test('an undocumented HTTP status is not explained with a guess', () => {
  const d = diagnose({ httpStatus: 418, body: null });
  assert.equal(d.outcome, 'http-error');
  assert.equal(d.why, null);
  assert.match(d.caveat, /will not guess/);
});

test('a network error says the status is unknown', () => {
  const d = diagnose({ networkError: 'fetch failed' }, { requestedId: ID });
  assert.equal(d.outcome, 'network-error');
  assert.equal(d.facts.postSubmissionId, ID);
  assert.match(d.whatHappened, /status is unknown/);
});

test('an undocumented status value is reported as unexpected, not explained', () => {
  const d = diagnose(ok({ postSubmissionId: ID, status: 'canceled' }));
  assert.equal(d.outcome, 'unexpected');
  assert.match(d.whatHappened, /"canceled"/);
  assert.equal(d.why, null);
});

test('a body that is not an object is reported as unexpected', () => {
  for (const body of [null, 'oops', [], 42]) {
    assert.equal(diagnose(ok(body)).outcome, 'unexpected');
  }
});

// ---------- Support reply draft ----------

test('support reply includes the ID, the original error, and numbered steps', () => {
  const d = diagnose(ok({ postSubmissionId: ID, status: 'failed', errorMessage: 'The user has not authorized application' }));
  assert.match(d.supportReply, /^Hi there,/);
  assert.match(d.supportReply, new RegExp(ID));
  assert.match(d.supportReply, /"The user has not authorized application"/);
  assert.match(d.supportReply, /\n1\. /);
  assert.match(d.supportReply, /\[Your name\]$/);
});

test('support reply for a scheduled post never says it was published', () => {
  const d = diagnose(ok({ postSubmissionId: ID, status: 'scheduled', scheduledTime: '2030-06-15T15:00:00Z' }), { now: NOW });
  assert.match(d.supportReply, /scheduled for June 15, 2030/);
  assert.match(d.supportReply, /has not been published yet/);
  assert.doesNotMatch(d.supportReply, /recorded this post as published/);
});

test('formatUtc pads hours and minutes', () => {
  assert.equal(formatUtc(new Date('2025-03-10T05:07:00Z')), 'March 10, 2025, 05:07 UTC');
});
