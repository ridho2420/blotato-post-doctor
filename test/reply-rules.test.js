// Guards the rules for customer reply drafts.
//
// The card is read by the support agent; the draft is read by the customer.
// These tests run over EVERY draft the app can produce (all samples, one per
// catalog entry, and the "check failed" cases), so a new sample or catalog
// entry is covered automatically.
//
// A phrase list only catches phrases someone listed. For a human read-through
// of every draft, open /drafts.html while the server is running.

import test from 'node:test';
import assert from 'node:assert/strict';

import { catalog, diagnose, PROMISES } from '../lib/diagnose.js';
import { buildAllDrafts } from '../lib/drafts.js';

const NOW = new Date('2026-11-11T00:00:00Z');
const ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const CHECK_FAILED_CASES = {
  'http-401': { httpStatus: 401, body: null },
  'http-403': { httpStatus: 403, body: null },
  'http-404': { httpStatus: 404, body: { statusCode: 404, message: 'Not found' } },
  'http-429': { httpStatus: 429, body: { statusCode: 429, message: 'Rate limit exceeded, retry in 49 seconds' } },
  'http-500': { httpStatus: 500, body: null },
  'http-503': { httpStatus: 503, body: null },
  'http-418': { httpStatus: 418, body: null },
  'network-error': { networkError: 'fetch failed' },
  'unexpected-status': { httpStatus: 200, body: { postSubmissionId: ID, status: 'canceled' } },
  'failed-no-message': { httpStatus: 200, body: { postSubmissionId: ID, status: 'failed' } },
};

// Every draft: [name, diagnosis-like object with customerReply]
function allReplies() {
  const replies = buildAllDrafts({ now: NOW }).map((draft) => ({
    name: `${draft.source}:${draft.id}`,
    kind: draft.replyKind,
    text: draft.text,
    beforeSending: draft.beforeSending,
  }));
  for (const [name, result] of Object.entries(CHECK_FAILED_CASES)) {
    const d = diagnose(result, { now: NOW, requestedId: ID });
    replies.push({ name, kind: d.customerReply.kind, text: d.customerReply.text, beforeSending: d.customerReply.beforeSending });
  }
  return replies;
}

const FORBIDDEN = [
  [/\.env\b/i, 'mentions the .env file'],
  [/BLOTATO_API_KEY/i, 'mentions the API key setting of this tool'],
  [/\bHTTP\b/, 'mentions HTTP'],
  [/\b(401|403|404|429|500|503)\b/, 'mentions an HTTP status code'],
  [/this tool|this app\b/i, 'talks about the tool'],
  [/\bcatalog\b/i, 'mentions the catalog'],
  [/contact (blotato )?support/i, 'tells the customer to contact support (the reply IS support)'],
  [/\bLogs\b/, 'sends the customer to Logs'],
  [/Error Reference/i, 'sends the customer to the Error Reference'],
  [/escalate/i, 'uses agent wording ("escalate")'],
  [/\bthe docs\b/i, 'talks about "the docs" (agent voice)'],
  [/the error (says|text)/i, 'uses agent wording ("the error says")'],
  [/(it|this) does not say/i, 'uses agent wording ("it does not say")'],
  [/(do not|don't) want to guess/i, 'sounds defensive ("do not want to guess")'],
  [/nothing (you|that you) need to (fix|do|change)|no action (is )?needed (on|from) your (side|end)/i, 'claims the customer has nothing to fix, which the tool cannot know'],
  [/as soon as possible|shortly|\bsoon\b|right away|immediately get back/i, 'promises speed'],
  [/(update you|follow up|get back to you|reply|respond)[^.\n]*\b(within|in|by)\b[^.\n]*\b(minutes?|hours?|days?|today|tomorrow)\b/i, 'promises a response time'],
];

test('no draft contains wording that belongs to the agent or to this tool', () => {
  for (const reply of allReplies()) {
    // The quoted error is Blotato's own text, shown as-is, so it is not judged here.
    const ownWords = reply.text.replace(/^The exact message was: ".*"$/m, '');
    for (const [pattern, problem] of FORBIDDEN) {
      assert.doesNotMatch(ownWords, pattern, `${reply.name}: draft ${problem}`);
    }
  }
});

test('every draft has a greeting, a sign-off, and invites a reply instead of a new ticket', () => {
  for (const reply of allReplies()) {
    assert.match(reply.text, /^Hi there,\n/, reply.name);
    assert.match(reply.text, /\nBest regards,\n\[Your name\]$/, reply.name);
    assert.match(reply.text, /reply to this message/i, reply.name);
  }
});

// ---------- Rule A: promises need a reminder ----------

// Written separately from the patterns in the code, on purpose.
const PROMISE_CHECKS = [
  [/technical team/i, /escalate/i],
  [/looking into/i, /investigat/i],
  [/update you/i, /follow-up/i],
];

test('a draft that promises an action comes with a reminder to do it first', () => {
  let draftsWithPromises = 0;
  for (const reply of allReplies()) {
    for (const [promise, reminder] of PROMISE_CHECKS) {
      if (promise.test(reply.text)) {
        draftsWithPromises += 1;
        assert.ok(
          reply.beforeSending.some((text) => /^Before sending:/.test(text) && reminder.test(text)),
          `${reply.name}: draft says "${promise.source}" but has no matching reminder`,
        );
      }
    }
  }
  assert.ok(draftsWithPromises > 0, 'expected at least one draft with a promise');
});

test('no draft makes a commitment the reminder system does not know about', () => {
  // Any sentence where support says it did, is doing, or will do something
  // must be one of the known promises (which all carry reminders).
  const commitment = /\b(we will|we'll|we are|we're|we have|we've|I will|I'll|I have|I've|I am)\b/i;
  const allowed = [
    /I do not have/i, // "I do not have a direct link"
    /I am sorry/i,
    /^The exact message was:/,
  ];
  for (const reply of allReplies()) {
    const sentences = reply.text.split(/(?<=[.?!:])\s+|\n+/);
    for (const sentence of sentences) {
      if (!commitment.test(sentence)) continue;
      if (allowed.some((pattern) => pattern.test(sentence))) continue;
      assert.ok(
        PROMISES.some((promise) => promise.pattern.test(sentence)),
        `${reply.name}: unlisted commitment in draft: "${sentence}"`,
      );
    }
  }
});

test('a draft that states a UTC time reminds the agent about the time zone', () => {
  const d = diagnose({ httpStatus: 200, body: { postSubmissionId: ID, status: 'scheduled', scheduledTime: '2030-06-15T15:00:00Z' } }, { now: NOW });
  assert.match(d.customerReply.text, /15:00 UTC/);
  assert.ok(d.customerReply.beforeSending.some((text) => /time zone/.test(text)));
});

// ---------- Unknown errors ----------

test('unknown error: acknowledges, quotes, escalates, asks not to resend, asks for details, guesses nothing', () => {
  const message = 'Example error text that is not in the catalog (ref: demo-0001)';
  const d = diagnose({ httpStatus: 200, body: { postSubmissionId: ID, status: 'failed', errorMessage: message } });
  const text = d.customerReply.text;
  assert.equal(d.customerReply.kind, 'diagnosis');
  assert.match(text, /sorry your post did not go through/i);
  assert.ok(text.includes(`"${message}"`));
  assert.match(text, /We do not know the cause yet\./);
  assert.match(text, /passed the details to our technical team/i);
  assert.match(text, /please do not submit the same post again/i);
  assert.match(text, /Which platform/i);
  assert.match(text, /kind of media/i);
  assert.match(text, /when you submitted it/i);
  assert.doesNotMatch(text, /What it means:|What you can do:/);
});

// ---------- The check itself failed ----------

test('when the check failed there is only an optional holding reply, and it names no cause', () => {
  for (const name of ['http-401', 'http-403', 'http-404', 'http-429', 'http-500', 'http-503', 'http-418', 'network-error', 'unexpected-status']) {
    const d = diagnose(CHECK_FAILED_CASES[name], { now: NOW, requestedId: ID });
    assert.equal(d.customerReply.kind, 'holding', name);
    assert.match(d.replyNote, /optional/i, name);
    assert.match(d.replyNote, /run it again before/i, name);
    const text = d.customerReply.text;
    assert.match(text, /please do not submit the same post again/i, name);
    assert.doesNotMatch(text, /api key|rate limit|subscription|billing|plan\b|server error|not found|rejected|refused|failed|error/i, `${name}: holding reply hints at a cause`);
    assert.doesNotMatch(text, /What it means:|What you can do:|your (key|account|plan|fault)/i, name);
  }
});

test('the holding reply is the same for every failed check, except 404 which also asks for the ID', () => {
  const textFor = (name) => diagnose(CHECK_FAILED_CASES[name], { now: NOW, requestedId: ID }).customerReply.text;
  const base = textFor('http-401');
  for (const name of ['http-403', 'http-429', 'http-500', 'network-error', 'unexpected-status']) {
    assert.equal(textFor(name), base, name);
  }
  const notFound = diagnose(CHECK_FAILED_CASES['http-404'], { now: NOW, requestedId: ID }).customerReply;
  assert.notEqual(notFound.text, base);
  assert.match(notFound.text, /send the submission ID again/i);
  assert.doesNotMatch(notFound.text, /wrong|incorrect|invalid|mistake/i);
  assert.doesNotMatch(notFound.text, /looking into|update you/i);
  assert.deepEqual(notFound.beforeSending, []);
});

test('the card for a 401 still tells the agent about the .env file', () => {
  const d = diagnose(CHECK_FAILED_CASES['http-401']);
  assert.ok(d.agentSteps.some((step) => /\.env/.test(step)));
  assert.ok(d.agentSteps.some((step) => /BLOTATO_API_KEY/.test(step)));
});

// ---------- Rule B: catalog entries ----------

test('every catalog entry has customer steps or is marked as handled by support', () => {
  for (const entry of catalog.entries) {
    const hasSteps = Array.isArray(entry.customerSteps) && entry.customerSteps.length > 0;
    assert.ok(hasSteps || entry.handledBySupport === true, `${entry.id}: needs customerSteps or handledBySupport`);
    if (entry.customerSteps) {
      assert.ok(entry.customerSteps.every((step) => typeof step === 'string' && step.trim().length > 10), `${entry.id}: customerSteps`);
    }
    assert.ok(typeof entry.example === 'string' && entry.example.length > 0, `${entry.id}: example`);
  }
});

test("every catalog entry's example error leads back to that entry", () => {
  for (const entry of catalog.entries) {
    const d = diagnose({ httpStatus: 200, body: { postSubmissionId: ID, status: 'failed', errorMessage: entry.example } });
    assert.equal(d.catalogEntryId, entry.id, `${entry.id}: example "${entry.example}"`);
  }
});

test('handled-by-support entries say so and give the customer no fix-it list', () => {
  const handled = catalog.entries.filter((entry) => entry.handledBySupport === true);
  assert.ok(handled.length > 0);
  for (const entry of handled) {
    const d = diagnose({ httpStatus: 200, body: { postSubmissionId: ID, status: 'failed', errorMessage: entry.example } });
    const text = d.customerReply.text;
    assert.equal(d.handledBySupport, true, entry.id);
    assert.match(text, /We need to look at this on our side before suggesting a fix./, entry.id);
    assert.match(text, /passed the details to our technical team/i, entry.id);
    assert.match(text, /please do not submit the same post again/i, entry.id);
    assert.doesNotMatch(text, /What you can do:/, entry.id);
  }
});

test('other known errors give the customer the catalog steps, and never the agent steps', () => {
  for (const entry of catalog.entries.filter((e) => e.handledBySupport !== true)) {
    const d = diagnose({ httpStatus: 200, body: { postSubmissionId: ID, status: 'failed', errorMessage: entry.example } });
    const text = d.customerReply.text;
    assert.match(text, /What you can do:/, entry.id);
    for (const step of entry.customerSteps) {
      assert.ok(text.includes(step), `${entry.id}: draft is missing customer step "${step}"`);
    }
    assert.deepEqual(d.agentSteps, entry.nextSteps, entry.id);
  }
});

// ---------- Other statuses ----------

test('drafts for unknown outcomes ask the customer not to resend', () => {
  const cases = [
    { postSubmissionId: ID, status: 'in-progress' },
    { postSubmissionId: ID, status: 'scheduled', scheduledTime: '2025-03-10T15:30:00Z' },
    { postSubmissionId: ID, status: 'failed' },
  ];
  for (const body of cases) {
    const d = diagnose({ httpStatus: 200, body }, { now: NOW });
    assert.match(d.customerReply.text, /please do not submit the same post again/i, body.status);
  }
});

test('a scheduled draft never says the post was published', () => {
  for (const scheduledTime of ['2030-06-15T15:00:00Z', '2025-03-10T15:30:00Z', 'not a date']) {
    const d = diagnose({ httpStatus: 200, body: { postSubmissionId: ID, status: 'scheduled', scheduledTime } }, { now: NOW });
    assert.doesNotMatch(d.customerReply.text, /(it|post) (was|is|has been) published/i, scheduledTime);
    assert.match(d.customerReply.text, /not (been |confirmed as )?published/i, scheduledTime);
  }
});

// ---------- Error details documented in the OpenAPI reference ----------

test('request ID, suggested action, and subscription status go on the card, never into the reply', () => {
  const body = { message: 'Forbidden access', reqId: 'req-abc-123', action: 'Renew the subscription.', subscriptionStatus: 'canceled' };
  const d = diagnose({ httpStatus: 403, body }, { requestedId: ID });
  assert.equal(d.apiRequestId, 'req-abc-123');
  assert.equal(d.apiSuggestedAction, 'Renew the subscription.');
  assert.equal(d.apiSubscriptionStatus, 'canceled');
  assert.equal(d.originalError, 'Forbidden access');
  for (const secretToCustomer of ['req-abc-123', 'Renew the subscription', 'canceled', 'Forbidden']) {
    assert.ok(!d.customerReply.text.includes(secretToCustomer), secretToCustomer);
  }
});

test('missing error details stay empty instead of being invented', () => {
  const d = diagnose({ httpStatus: 500, body: null });
  assert.equal(d.apiRequestId, null);
  assert.equal(d.apiSuggestedAction, null);
  assert.equal(d.apiSubscriptionStatus, null);
});

test('the 404 card says the response is documented but its meaning is not', () => {
  const d = diagnose({ httpStatus: 404, body: { message: 'Resource not found' } });
  assert.match(d.caveat, /OpenAPI reference lists a 404/);
  assert.match(d.caveat, /cannot say what was not found/);
  assert.equal(d.why, null);
});

test('"Invalid account credentials" restates the message, guesses no cause, and is handled by support', () => {
  const d = diagnose({ httpStatus: 200, body: { postSubmissionId: ID, status: 'failed', errorMessage: 'Invalid account credentials' } });
  assert.equal(d.catalogEntryId, 'account-invalid-credentials');
  assert.equal(d.handledBySupport, true);
  assert.match(d.why, /does not say which account, or why/);
  assert.doesNotMatch(d.customerReply.text, /reconnect|expired|password|token/i);
  const entry = catalog.entries.find((e) => e.id === 'account-invalid-credentials');
  assert.match(entry.sourceNote, /Error Reference has no row/);
});

// ---------- Customer explanations and questions ----------

test('every catalog entry has its own explanation written for the customer', () => {
  for (const entry of catalog.entries) {
    assert.ok(typeof entry.customerWhy === 'string' && entry.customerWhy.trim().length > 15, `${entry.id}: customerWhy`);
    const d = diagnose({ httpStatus: 200, body: { postSubmissionId: ID, status: 'failed', errorMessage: entry.example } });
    assert.ok(d.customerReply.text.includes(`What it means: ${entry.customerWhy}`), `${entry.id}: draft must use customerWhy`);
    assert.equal(d.why, entry.why, `${entry.id}: the card keeps the agent explanation`);
  }
});

test('a draft that asks the customer for the submission ID does not also claim to be investigating', () => {
  const asksForId = /(send|confirm|tell me)[^.?]*\bsubmission ID\b|submission ID, exactly as you received it/i;
  let found = 0;
  for (const reply of allReplies()) {
    if (!asksForId.test(reply.text)) continue;
    found += 1;
    assert.doesNotMatch(reply.text, /looking into|investigat|I checked your post|we are checking/i, `${reply.name}: asks for the ID but claims to be investigating`);
    assert.ok(!reply.beforeSending.some((text) => /investigat/i.test(text)), `${reply.name}: stale investigation reminder`);
  }
  assert.ok(found >= 2, 'expected the in-progress draft and the 404 holding reply to ask for the ID');
});

test('the in-progress draft states the result, then asks for the ID, platform, and time', () => {
  const d = diagnose({ httpStatus: 200, body: { postSubmissionId: ID, status: 'in-progress' } });
  const text = d.customerReply.text;
  assert.ok(text.includes(`With the submission ID ${ID}, there is no final result yet`));
  const order = ['no final result yet', 'The submission ID, exactly as you received it', 'Which platform and account', 'Roughly when you submitted it'].map((part) => text.indexOf(part));
  assert.ok(order.every((index) => index > 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.deepEqual(d.customerReply.beforeSending, []);
});

test('entries that lack detail ask the customer in one plain sentence, not a list', () => {
  for (const id of ['media-unsupported-type', 'account-invalid-credentials']) {
    const entry = catalog.entries.find((e) => e.id === id);
    assert.ok(typeof entry.customerAsk === 'string' && !entry.customerAsk.includes('\n'), id);
    const d = diagnose({ httpStatus: 200, body: { postSubmissionId: ID, status: 'failed', errorMessage: entry.example } });
    assert.ok(d.customerReply.text.includes('\n\n' + entry.customerAsk + '\n\n'), `${id}: the ask must be its own paragraph`);
  }
});

// ---------- Layout ----------

// Groups of consecutive "1. ...", "2. ..." lines.
function numberedLists(text) {
  const lists = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (/^\d+\. /.test(line)) {
      if (!current) { current = []; lists.push(current); }
      current.push(line);
    } else {
      current = null;
    }
  }
  return lists;
}

test('a draft has at most one numbered list', () => {
  for (const reply of allReplies()) {
    assert.ok(numberedLists(reply.text).length <= 1, `${reply.name}: more than one numbered list`);
  }
});

test('a numbered list has at least two items, numbered from 1', () => {
  for (const reply of allReplies()) {
    for (const list of numberedLists(reply.text)) {
      assert.ok(list.length >= 2, `${reply.name}: numbered list with a single item`);
      list.forEach((line, index) => assert.ok(line.startsWith(`${index + 1}. `), `${reply.name}: list numbering`));
    }
  }
});

test('a numbered list is followed by a blank line, never by text stuck to it', () => {
  for (const reply of allReplies()) {
    const lines = reply.text.split('\n');
    lines.forEach((line, index) => {
      if (!/^\d+\. /.test(line)) return;
      const next = lines[index + 1] ?? '';
      assert.ok(next === '' || /^\d+\. /.test(next), `${reply.name}: text directly after a list: "${next}"`);
    });
  }
});

test('the video-too-long draft does not claim the error names a requirement', () => {
  const d = diagnose({ httpStatus: 200, body: { postSubmissionId: ID, status: 'failed', errorMessage: 'This video is 185 seconds long, but we can only automatically fix videos up to 120 seconds' } });
  assert.doesNotMatch(d.customerReply.text, /names the requirement/i);
});

test('agent steps never tell the support agent to "contact support"', () => {
  for (const entry of catalog.entries) {
    for (const step of entry.nextSteps) {
      assert.doesNotMatch(step, /contact (blotato )?support|send blotato support/i, entry.id);
    }
  }
});

// ---------- Repeated sentences ----------

// Splits a piece of draft text into normalized sentences.
function sentencesOf(text) {
  const sentences = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine
      .replace(/^\d+\. /, '')
      .replace(/^What it means: /, '')
      .replace(/^What you can do:\s*/, '');
    for (const part of line.split(/(?<=[.!?])\s+/)) {
      const sentence = part.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/, '').trim();
      if (sentence.split(' ').length >= 4) sentences.push(sentence);
    }
  }
  return sentences;
}

// Share of words two sentences have in common (1 = same words).
function wordOverlap(a, b) {
  const words = (s) => new Set(s.replace(/[^a-z0-9+ ]/g, ' ').split(' ').filter(Boolean));
  const A = words(a);
  const B = words(b);
  const shared = [...A].filter((w) => B.has(w)).length;
  return shared / new Set([...A, ...B]).size;
}

// The "What it means" paragraph and the "What you can do" part of a draft.
function sectionsOf(text) {
  const lines = text.split('\n');
  const means = lines.find((line) => line.startsWith('What it means: ')) ?? '';
  const start = lines.findIndex((line) => line.startsWith('What you can do:'));
  const canDo = [];
  if (start >= 0) {
    canDo.push(lines[start]);
    for (let i = start + 1; i < lines.length && /^\d+\. /.test(lines[i]); i++) canDo.push(lines[i]);
  }
  return { means, canDo: canDo.join('\n') };
}

const NEAR_DUPLICATE = 0.7;

test('"What it means" and "What you can do" never repeat the same sentence, even reworded', () => {
  let checked = 0;
  for (const reply of allReplies()) {
    const { means, canDo } = sectionsOf(reply.text);
    if (!means || !canDo) continue;
    checked += 1;
    for (const a of sentencesOf(means)) {
      for (const b of sentencesOf(canDo)) {
        assert.ok(wordOverlap(a, b) < NEAR_DUPLICATE, `${reply.name}: "${a}" is repeated in "What you can do" as "${b}"`);
      }
    }
  }
  assert.ok(checked > 40, 'expected many drafts with both sections');
});

test('no sentence appears twice in one draft', () => {
  for (const reply of allReplies()) {
    const seen = new Set();
    for (const sentence of sentencesOf(reply.text)) {
      assert.ok(!seen.has(sentence), `${reply.name}: sentence appears twice: "${sentence}"`);
      seen.add(sentence);
    }
  }
});

// ---------- 24-hour posting limit ----------

const LISTED_LIMIT_PLATFORMS = ['YouTube', 'Facebook', 'LinkedIn', 'Slack'];
const limitMessage = (n, platform) =>
  `You have reached the maximum number of ${n} posts for the last 24 hours for this account${platform ? ` (${platform})` : ''}`;
const ownWordsOf = (text) => text.replace(/^The exact message was: ".*"$/m, '');

test('a 24-hour limit error from an unlisted or unnamed platform gets no list of platform limits', () => {
  const cases = [
    limitMessage(10, 'TikTok'),
    limitMessage(25, 'TikTok'),
    limitMessage(50, 'Instagram'),
    limitMessage(20, 'Pinterest'),
    limitMessage(25),
    limitMessage(10),
  ];
  for (const message of cases) {
    const d = diagnose({ httpStatus: 200, body: { postSubmissionId: ID, status: 'failed', errorMessage: message } });
    assert.equal(d.catalogEntryId, 'posting-limit-24h', message);
    const own = ownWordsOf(d.customerReply.text);
    for (const platform of LISTED_LIMIT_PLATFORMS) {
      assert.ok(!own.includes(platform), `${message}: draft mentions ${platform}`);
    }
    assert.doesNotMatch(own, /\b(10|20|25|50|100) (posts|per)\b/, `${message}: draft quotes a limit number`);
    assert.match(own, /check whether the original post already went out/i, message);
  }
});

test('a 24-hour limit error that names a listed platform talks only about that platform', () => {
  const numbers = { YouTube: 10, Facebook: 25, LinkedIn: 50, Slack: 100 };
  for (const platform of LISTED_LIMIT_PLATFORMS) {
    const d = diagnose({ httpStatus: 200, body: { postSubmissionId: ID, status: 'failed', errorMessage: limitMessage(numbers[platform], platform) } });
    assert.equal(d.catalogEntryId, `posting-limit-24h-${platform.toLowerCase()}`, platform);
    const own = ownWordsOf(d.customerReply.text);
    assert.ok(own.includes(platform), platform);
    for (const other of LISTED_LIMIT_PLATFORMS.filter((p) => p !== platform)) {
      assert.ok(!own.includes(other), `${platform} draft mentions ${other}`);
    }
  }
});

test('Facebook and LinkedIn limit drafts do not describe a rolling window', () => {
  for (const platform of ['Facebook', 'LinkedIn']) {
    const d = diagnose({ httpStatus: 200, body: { postSubmissionId: ID, status: 'failed', errorMessage: limitMessage(platform === 'Facebook' ? 25 : 50, platform) } });
    assert.doesNotMatch(d.customerReply.text, /rolling|in any 24 hours|drop out of the 24-hour window/i, platform);
  }
});

test('the YouTube limit draft tells the customer to check the original post before trying again', () => {
  const d = diagnose({ httpStatus: 200, body: { postSubmissionId: ID, status: 'failed', errorMessage: limitMessage(10, 'YouTube') } });
  assert.match(d.customerReply.text, /Before trying again or uploading the video manually, check whether the original post already went out/);
});
