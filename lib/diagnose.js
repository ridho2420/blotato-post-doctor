// The "doctor" part of the app.
//
// Input:  the raw answer from Blotato's "Get Post" endpoint
//         (GET https://backend.blotato.com/v2/posts/:postSubmissionId).
// Output: a diagnosis with two separate audiences:
//           - the CARD is read by the support agent  (agentSteps, caveat, links)
//           - the REPLY DRAFT is read by the customer (customerReply.text)
//
// Ground rules, taken from the official docs and from the project brief:
//   - Only four statuses are documented: published, failed, in-progress, scheduled.
//   - "in-progress" does not prove the ID is valid (the API returns it for unknown IDs too).
//   - "scheduled" is not "published".
//   - Never tell anyone to simply resubmit: that risks a duplicate post.
//   - If a failed post's errorMessage is not in the catalog, show the original
//     text, say it is not recognized, and do NOT guess a cause.
//
// Rules for the customer reply draft:
//   - Nothing about this tool's own setup (.env, API key variable, HTTP codes, "catalog").
//   - Never "contact Blotato support" (the reply IS from support): say "reply to this message".
//   - Never send the customer to Logs or the Error Reference; that is the agent's job.
//   - Never promise a response time.
//   - No agent-voice wording ("the docs say", "the error says", "it does not say"), and no
//     defensive wording ("do not want to guess"): say "we do not know the cause yet".
//   - A draft has at most one numbered list, and a numbered list has at least two items.
//   - A draft that asks the customer for the submission ID must not also claim an
//     investigation is under way.
//   - When the check itself failed (HTTP error, network error), there is no diagnosis
//     draft at all, only an optional holding reply that names no cause.
//   - Any draft that says something was done or will be done ("passed to our technical
//     team", "looking into it", "we will update you") comes with a "before sending"
//     reminder for the agent to actually do it first.

import { readFileSync } from 'node:fs';

export const catalog = JSON.parse(
  readFileSync(new URL('./error-catalog.json', import.meta.url), 'utf8'),
);

export const DOCS = {
  getPost: {
    label: 'Get Post (check post status)',
    url: 'https://help.blotato.com/start-with-an-ai-agent/llm#get-post-v2-posts-postsubmissionid',
  },
  postLifecycle: {
    label: 'Post lifecycle',
    url: 'https://help.blotato.com/api-and-mcp-concepts/post-lifecycle',
  },
  findOutcome: {
    label: "Find a post's outcome before retrying",
    url: 'https://help.blotato.com/start-with-an-ai-agent/publishing-status',
  },
  getPostOpenApi: {
    label: 'Get Post in the OpenAPI reference (error responses)',
    url: 'https://help.blotato.com/rest-api-reference/openapi-reference/publishing',
  },
  errorsAndRetries: {
    label: 'Errors and retries',
    url: 'https://help.blotato.com/api-and-mcp-concepts/error-handling',
  },
  errorReference: { label: 'Error Reference', url: 'https://help.blotato.com/support/errors' },
  rateLimits: { label: 'Rate limits', url: 'https://help.blotato.com/api-and-mcp-concepts/rate-limits' },
  authentication: {
    label: 'Access and authentication',
    url: 'https://help.blotato.com/api-and-mcp-concepts/authentication',
  },
  quickstart: { label: 'REST API quickstart', url: 'https://help.blotato.com/start-with-an-ai-agent/start' },
  logs: { label: 'Blotato Logs', url: 'https://my.blotato.com/logs' },
  failedPosts: { label: 'Failed posts', url: 'https://my.blotato.com/posts?status=failed' },
  billing: { label: 'Billing settings', url: 'https://my.blotato.com/settings/billing' },
};

// ---------- Wording shared by the customer drafts ----------

const PROMISE_ESCALATED = 'I have passed the details to our technical team.';
// Used when the draft then asks the customer something: it names what was
// passed on, so the question reads as help for the team, not as a contradiction.
const PROMISE_ESCALATED_ERROR = 'I have passed your submission ID and the exact error to our technical team.';
const PROMISE_ESCALATED_ID = 'I have passed your submission ID to our technical team.';
const PROMISE_INVESTIGATING = 'We are looking into it.';
const PROMISE_UPDATE = 'We will update you here once we know more.';
const PLEASE_DO_NOT_RESEND = 'In the meantime, please do not submit the same post again, so we can avoid a duplicate.';
const CLOSING_DEFAULT = 'If anything is unclear, just reply to this message.';
const CLOSING_AFTER_STEPS = 'If it still does not work after these steps, or anything is unclear, just reply to this message.';

/**
 * Every sentence in a draft that says something was done or will be done.
 * Each one adds a reminder for the agent, shown next to the draft.
 */
export const PROMISES = [
  {
    pattern: /passed (this|the details|your submission ID and the exact error) to our technical team/i,
    reminder: 'Before sending: actually escalate this case to the technical team (submission ID plus the exact error). The draft says you already did.',
  },
  {
    pattern: /passed your submission ID to our technical team/i,
    reminder: 'Before sending: actually escalate this case to the technical team (submission ID, and a note that the failed status had no error message). The draft says you already did.',
  },
  {
    pattern: /looking into (it|this)/i,
    reminder: 'Before sending: make sure this is really being investigated, by you or by the team. The draft says it is.',
  },
  {
    pattern: /we will update you/i,
    reminder: 'Before sending: set a follow-up for this customer. The draft promises an update (it does not promise a time; do not add one unless you can keep it).',
  },
];

const TIMEZONE_REMINDER = "Before sending: the time in the draft is in UTC. Convert it to the customer's time zone, or keep the \"UTC\" label.";

// ---------- Small helpers ----------

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "2030-06-15T15:00:00Z" -> "June 15, 2030, 15:00 UTC". */
export function formatUtc(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}, ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isHttpUrl(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

// Lower-case, straighten curly apostrophes, and collapse spaces, so small
// formatting differences do not stop a match.
function normalize(text) {
  return String(text).toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * Looks up an errorMessage in the catalog.
 * Returns the first matching entry, or null when nothing matches.
 */
export function matchError(errorMessage, entries = catalog.entries) {
  if (!isNonEmptyString(errorMessage)) return null;
  const haystack = normalize(errorMessage);
  for (const entry of entries) {
    const containsMatch = (entry.matchAny ?? []).some((needle) => haystack.includes(normalize(needle)));
    const regexMatch = entry.matchRegex ? new RegExp(entry.matchRegex, 'i').test(haystack) : false;
    if (containsMatch || regexMatch) {
      return entry;
    }
  }
  return null;
}

function numbered(steps) {
  return steps.map((step, index) => `${index + 1}. ${step}`);
}

function idPart(facts) {
  return facts.postSubmissionId ? ` (submission ID: ${facts.postSubmissionId})` : '';
}

/**
 * Wraps the body of a customer reply with a greeting and sign-off, and works
 * out which "before sending" reminders the agent needs.
 *
 * @param {'diagnosis'|'holding'} kind
 * @param {string[]} body      Paragraphs / lines. Use '' for a blank line.
 * @param {string}   closing   Last sentence before the sign-off.
 */
function buildReply(kind, body, closing = CLOSING_DEFAULT) {
  const text = ['Hi there,', '', ...body, '', closing, '', 'Best regards,', '[Your name]'].join('\n');
  const beforeSending = PROMISES.filter((promise) => promise.pattern.test(text)).map((promise) => promise.reminder);
  if (/\bUTC\b/.test(text)) beforeSending.push(TIMEZONE_REMINDER);
  return { kind, text, beforeSending };
}

/** The optional holding reply used when the check itself failed. It names no cause. */
function holdingReply(facts) {
  return buildReply('holding', [
    `Thanks for reaching out about your post${idPart(facts)}.`,
    '',
    `${PROMISE_INVESTIGATING} ${PROMISE_UPDATE}`,
    '',
    PLEASE_DO_NOT_RESEND,
  ]);
}

const HOLDING_NOTE = 'No diagnosis reply for this result: the check itself did not work, so nothing is known about the post yet. Fix the check and run it again before you explain anything to the customer. The holding reply below is optional; use it only if the customer is waiting for an answer.';

function finish(partial, facts) {
  return {
    outcome: partial.outcome,
    tone: partial.tone,
    checkCompleted: partial.checkCompleted ?? true,
    headline: partial.headline,
    whatHappened: partial.whatHappened,
    why: partial.why ?? null,
    caveat: partial.caveat ?? null,
    recognized: partial.recognized ?? null,
    // Extra fields Blotato may send with an error response (see the OpenAPI reference).
    apiRequestId: partial.apiRequestId ?? null,
    apiSuggestedAction: partial.apiSuggestedAction ?? null,
    apiSubscriptionStatus: partial.apiSubscriptionStatus ?? null,
    category: partial.category ?? null,
    catalogEntryId: partial.catalogEntryId ?? null,
    handledBySupport: partial.handledBySupport ?? null,
    originalError: partial.originalError ?? null,
    // For the support agent (shown on the card).
    agentSteps: partial.agentSteps ?? [],
    links: partial.links ?? [],
    facts,
    // For the customer (shown as an editable draft).
    replyNote: partial.replyNote ?? null,
    customerReply: partial.customerReply,
  };
}

// ---------- The four documented statuses ----------

function diagnosePublished(body, facts) {
  if (facts.publicUrl) {
    return finish({
      outcome: 'published',
      tone: 'success',
      headline: 'Published',
      whatHappened: `Blotato recorded this post as published. Public URL: ${facts.publicUrl}`,
      agentSteps: [
        'Open the public URL and confirm the post is on the intended account.',
        'If the link does not open or the post is missing, do not tell the customer to post again yet. An inaccessible URL alone does not prove the post was deleted or blocked. Keep the submission ID and escalate.',
      ],
      links: [DOCS.findOutcome, DOCS.postLifecycle],
      customerReply: buildReply('diagnosis', [
        `Thanks for reaching out. I checked your post${idPart(facts)}, and it was published.`,
        '',
        `You can see it here: ${facts.publicUrl}`,
        '',
        'If it does not appear on your account, reply to this message and please do not post it again yet, so we can avoid a duplicate.',
      ]),
    }, facts);
  }
  return finish({
    outcome: 'published',
    tone: 'success',
    headline: 'Published (no public URL returned)',
    whatHappened: 'Blotato recorded this post as published, but did not return a public URL for it. The docs say that field is optional.',
    agentSteps: [
      'Look for the post under Posts > Published in Blotato, and on the destination account if you can see it.',
      'If it cannot be found, do not tell the customer to post again yet. A missing URL alone does not prove the post was deleted or blocked. Keep the submission ID and escalate.',
    ],
    links: [DOCS.findOutcome, DOCS.postLifecycle],
    customerReply: buildReply('diagnosis', [
      `Thanks for reaching out. I checked your post${idPart(facts)}. Our records show it as published, but I do not have a direct link to it.`,
      '',
      'Could you check the account you posted to and confirm it is there?',
      '',
      'If you cannot find it, reply to this message and please do not post it again yet, so we can avoid a duplicate.',
    ]),
  }, facts);
}

function diagnoseScheduled(body, facts, now) {
  const when = isNonEmptyString(body.scheduledTime) ? new Date(body.scheduledTime) : null;
  const links = [DOCS.postLifecycle, DOCS.findOutcome];

  if (!when || Number.isNaN(when.getTime())) {
    return finish({
      outcome: 'scheduled',
      tone: 'info',
      headline: 'Scheduled - not published yet',
      whatHappened: 'Blotato reports this post as scheduled. It has not been published yet. The response did not include a readable scheduled time.',
      agentSteps: [
        'Look up the post under Posts > Scheduled in Blotato to find its publish time, and add it to the reply.',
        'Check this ID again after that time to confirm it was published.',
      ],
      links,
      customerReply: buildReply('diagnosis', [
        `Thanks for reaching out. I checked your post${idPart(facts)}. It is scheduled and has not been published yet.`,
        '',
        'You can see its publish time, and change or cancel it, under Posts > Scheduled in Blotato.',
      ]),
    }, facts);
  }

  const whenText = formatUtc(when);

  if (when.getTime() <= now.getTime()) {
    return finish({
      outcome: 'scheduled',
      tone: 'warning',
      headline: 'Scheduled, but the scheduled time has passed',
      whatHappened: `Blotato reports this post as scheduled for ${whenText}, but that time has already passed. It is not confirmed as published.`,
      caveat: 'This response does not say why the status is still "scheduled", and this tool will not guess.',
      agentSteps: [
        'Look for this post in Blotato under Posts, using the Scheduled, Published, and Failed filters.',
        'Check the destination account on the platform as well, if you can see it.',
        'Do not ask the customer to submit the post again while the outcome is unknown; that risks a duplicate.',
        'If those checks do not settle it, escalate with the submission ID and the scheduled time.',
      ],
      links,
      customerReply: buildReply('diagnosis', [
        `Thanks for reaching out. I checked your post${idPart(facts)}.`,
        '',
        `It shows as scheduled for ${whenText}. That time has already passed, and the post is not confirmed as published. We do not know the cause yet. ${PROMISE_INVESTIGATING} ${PROMISE_UPDATE}`,
        '',
        PLEASE_DO_NOT_RESEND,
        '',
        'If you can already see the post on your account, please let me know.',
      ]),
    }, facts);
  }

  return finish({
    outcome: 'scheduled',
    tone: 'info',
    headline: 'Scheduled - not published yet',
    whatHappened: `This post is scheduled for ${whenText}. It has not been published yet.`,
    agentSteps: [
      'Nothing needs fixing. The post is waiting for its scheduled time.',
      'Check this ID again after that time if the customer needs confirmation that it was published.',
    ],
    links,
    customerReply: buildReply('diagnosis', [
      `Thanks for reaching out. I checked your post${idPart(facts)}.`,
      '',
      `It is scheduled for ${whenText}. It has not been published yet; it is waiting for its scheduled time.`,
      '',
      'If you would like to change or cancel it, you can do that under Posts > Scheduled in Blotato.',
    ]),
  }, facts);
}

function diagnoseInProgress(body, facts) {
  return finish({
    outcome: 'in-progress',
    tone: 'waiting',
    headline: 'No final result yet',
    whatHappened: 'Blotato has no published, failed, or scheduled result for this ID yet.',
    caveat: 'The API returns "in-progress" both while a post is still being processed and when no record matches the ID at all. So this answer does not prove the ID is valid.',
    agentSteps: [
      'Check you entered the ID exactly. It must be the postSubmissionId from the original create response, not a schedule ID or a published-post ID.',
      'Check the API key this tool uses belongs to the same Blotato account that created the post.',
      'Check again, waiting at least 10 seconds between checks, and stop after a couple of minutes.',
      'If it is still in progress after that, keep the ID and look in Blotato under Posts and Logs, or escalate. Reaching the time limit is not proof that the post failed.',
      'Do not ask the customer to submit the post again while the outcome is unknown; that risks a duplicate.',
    ],
    links: [DOCS.getPost, DOCS.findOutcome, DOCS.logs],
    customerReply: buildReply('diagnosis', [
      'Thanks for reaching out about your post.',
      '',
      facts.postSubmissionId
        ? `With the submission ID ${facts.postSubmissionId}, there is no final result yet: the post is not showing as published, failed, or scheduled.`
        : 'There is no final result for this post yet: it is not showing as published, failed, or scheduled.',
      '',
      'To make sure this is the right post, could you confirm:',
      ...numbered([
        'The submission ID, exactly as you received it when the post was created.',
        'Which platform and account you posted to.',
        'Roughly when you submitted it (with your time zone).',
      ]),
      '',
      PLEASE_DO_NOT_RESEND,
    ]),
  }, facts);
}

// ---------- Failed posts ----------

// Comes right after the sentence that says what was passed to the technical team.
const ASK_FOR_DETAILS = [
  'To help them, could you tell me:',
  ...numbered([
    'Which platform and account you were posting to.',
    'What kind of media the post had (image, video, or text only).',
    'Roughly when you submitted it (with your time zone).',
  ]),
];

function diagnoseFailed(body, facts) {
  const whatHappened = 'Blotato marked this post as failed: publishing stopped and an error was reported.';
  const genericAgentSteps = [
    'Open the failed request in Blotato Logs to see the full payload, response, and error.',
    'Search the Blotato Error Reference for the exact error text.',
    'Do not ask the customer to submit the same post again unchanged. The docs warn that an unchanged retry often fails for the same reason.',
    'If the cause is still unclear, escalate to the technical team with the submission ID and the exact error text. Never include an API key.',
  ];
  const genericLinks = [DOCS.logs, DOCS.failedPosts, DOCS.errorReference, DOCS.errorsAndRetries];

  if (!isNonEmptyString(body.errorMessage)) {
    return finish({
      outcome: 'failed',
      tone: 'error',
      headline: 'Failed, but no error message was returned',
      whatHappened,
      recognized: false,
      caveat: 'The docs say a failed result includes an errorMessage, but this response did not have one. Without it, this tool will not guess at the cause.',
      agentSteps: [genericAgentSteps[0], genericAgentSteps[2], genericAgentSteps[3]],
      links: genericLinks,
      customerReply: buildReply('diagnosis', [
        `Thanks for reaching out, and I am sorry your post did not go through. I checked it${idPart(facts)}: publishing stopped with an error.`,
        '',
        `The status does not include an error message, so we do not know the cause yet. ${PROMISE_ESCALATED_ID}`,
        '',
        ...ASK_FOR_DETAILS,
        '',
        `${PROMISE_UPDATE} ${PLEASE_DO_NOT_RESEND}`,
      ]),
    }, facts);
  }

  const originalError = body.errorMessage;
  const entry = matchError(originalError);

  if (!entry) {
    return finish({
      outcome: 'failed',
      tone: 'error',
      headline: 'Failed with an error this tool does not recognize',
      whatHappened,
      recognized: false,
      originalError,
      caveat: "This error text is not in this tool's catalog yet. It is shown exactly as Blotato returned it, and this tool will not guess at the cause.",
      agentSteps: genericAgentSteps,
      links: genericLinks,
      customerReply: buildReply('diagnosis', [
        `Thanks for reaching out, and I am sorry your post did not go through. I checked it${idPart(facts)}: publishing stopped with an error.`,
        '',
        `The exact message was: "${originalError}"`,
        '',
        `We do not know the cause yet. ${PROMISE_ESCALATED_ERROR}`,
        '',
        ...ASK_FOR_DETAILS,
        '',
        `${PROMISE_UPDATE} ${PLEASE_DO_NOT_RESEND}`,
      ]),
    }, facts);
  }

  // A known error. The customer only gets fixes the official Error Reference gives.
  const customerSteps = entry.customerSteps ?? [];
  const replyBody = [
    `Thanks for reaching out. I checked your post${idPart(facts)}. It did not go through: publishing stopped with an error.`,
    '',
    `The exact message was: "${originalError}"`,
    '',
    `What it means: ${entry.customerWhy}`,
  ];
  let closing = CLOSING_AFTER_STEPS;

  if (entry.handledBySupport && entry.customerAsk) {
    // The question follows the escalation directly and says it is there to help the team.
    replyBody.push(
      '',
      `We need to look at this on our side before suggesting a fix. ${PROMISE_ESCALATED_ERROR}`,
      '',
      entry.customerAsk,
      '',
      `${PROMISE_UPDATE} ${PLEASE_DO_NOT_RESEND}`,
    );
    if (customerSteps.length > 0) {
      replyBody.push('', ...customerSteps);
    }
    closing = CLOSING_DEFAULT;
  } else if (entry.handledBySupport) {
    replyBody.push(
      '',
      `We need to look at this on our side before suggesting a fix. ${PROMISE_ESCALATED} ${PROMISE_UPDATE}`,
      '',
      PLEASE_DO_NOT_RESEND,
    );
    if (customerSteps.length > 0) {
      replyBody.push('', ...customerSteps);
    }
    closing = CLOSING_DEFAULT;
  } else {
    // A numbered list needs at least two items; a single step is written as a sentence.
    if (customerSteps.length === 1) {
      replyBody.push('', `What you can do: ${customerSteps[0]}`);
    } else {
      replyBody.push('', 'What you can do:', ...numbered(customerSteps));
    }
  }
  if (entry.customerAsk && !entry.handledBySupport) {
    replyBody.push('', entry.customerAsk);
  }

  return finish({
    outcome: 'failed',
    tone: 'error',
    headline: `Failed: ${entry.title}`,
    whatHappened,
    why: entry.why,
    recognized: true,
    category: entry.category,
    catalogEntryId: entry.id,
    handledBySupport: entry.handledBySupport === true,
    originalError,
    agentSteps: entry.nextSteps,
    links: entry.links ?? [DOCS.errorReference],
    customerReply: buildReply('diagnosis', replyBody, closing),
  }, facts);
}

// ---------- Problems with the check itself ----------

function diagnoseHttpError(httpStatus, body, facts) {
  // The OpenAPI reference documents error bodies for this endpoint (403, 404, 429, 500)
  // with "message" plus optional "reqId", "action", and for 403 "subscriptionStatus".
  const field = (name) => (body && typeof body === 'object' && isNonEmptyString(body[name]) ? body[name] : null);
  const apiMessage = field('message');
  const base = {
    outcome: 'http-error',
    tone: 'error',
    checkCompleted: false,
    originalError: apiMessage,
    apiRequestId: field('reqId'),
    apiSuggestedAction: field('action'),
    apiSubscriptionStatus: field('subscriptionStatus'),
    replyNote: HOLDING_NOTE,
    customerReply: holdingReply(facts),
  };

  if (httpStatus === 401) {
    return finish({
      ...base,
      headline: 'Blotato rejected the API key (HTTP 401)',
      whatHappened: 'The status check was rejected before Blotato looked at the post, so nothing is known about the post itself yet.',
      why: 'Blotato returns a 401 when the API key is missing or not valid. This is about the key this tool uses, not about the customer.',
      agentSteps: [
        'Copy the full API key again from Settings > API in Blotato. Keys sometimes end with one or more "=" characters; include them.',
        'Make sure there are no spaces or line breaks around the key in the .env file (BLOTATO_API_KEY=...).',
        'Restart this app after changing the .env file, then check the post again.',
        'Note: API access is only included on paid Blotato plans, and generating an API key ends a free trial immediately.',
      ],
      links: [DOCS.authentication, DOCS.quickstart],
    }, facts);
  }

  if (httpStatus === 403) {
    return finish({
      ...base,
      headline: 'Blotato refused the request (HTTP 403)',
      whatHappened: 'The status check was refused, so nothing is known about the post itself yet.',
      why: 'The docs connect a 403 from the API to subscription status: API access needs an active paid plan. This is about the account whose API key this tool uses.',
      caveat: 'This tool cannot see billing status, so it cannot confirm that this is the reason.',
      agentSteps: [
        'Check the plan and payment status of the account whose API key this tool uses (Settings > Billing).',
        'If the subscription is active and the 403 continues, escalate with the exact response (and the request ID, if one is shown).',
      ],
      links: [DOCS.billing, DOCS.getPostOpenApi, DOCS.errorsAndRetries],
    }, facts);
  }

  if (httpStatus === 404) {
    return finish({
      ...base,
      headline: 'Blotato could not find this (HTTP 404)',
      whatHappened: 'Blotato answered "not found" to the status check, so nothing is known about the post itself yet.',
      caveat: 'The OpenAPI reference lists a 404 "Not found" response for this endpoint, but the docs do not say when it is returned instead of "in-progress" (the documented answer for an ID with no matching record). So this tool cannot say what was not found. It may be a typo on our side, the wrong account\'s API key, or an ID the customer copied incorrectly.',
      agentSteps: [
        'Check the ID you entered has no extra spaces or characters. It must be the postSubmissionId from the original create response, not a schedule ID or a published-post ID.',
        'Check the API key this tool uses belongs to the same Blotato account that created the post.',
        'If both are right, ask the customer to send the ID again (the holding reply below does this), then escalate if the 404 continues.',
      ],
      links: [DOCS.getPostOpenApi, DOCS.errorsAndRetries, DOCS.getPost],
      // This reply asks for the ID again, so it must not also claim an investigation is under way.
      customerReply: buildReply('holding', [
        `Thanks for reaching out about your post${idPart(facts)}.`,
        '',
        'To make sure this is about the right post, could you send the submission ID again, exactly as you received it when the post was created?',
        '',
        PLEASE_DO_NOT_RESEND,
      ]),
    }, facts);
  }

  if (httpStatus === 429) {
    return finish({
      ...base,
      tone: 'warning',
      headline: 'Too many status checks (HTTP 429)',
      whatHappened: 'Blotato is temporarily limiting requests from the API key this tool uses, so the post was not checked this time.',
      why: 'Blotato limits this endpoint to 60 requests per minute.',
      caveat: 'This limit is about API requests only. It says nothing about whether the post itself succeeded or failed.',
      agentSteps: [
        apiMessage
          ? 'Stop checking for now. If the message above says how long to wait, wait at least that long.'
          : 'Stop checking for now and wait a minute before trying again.',
        'After that, leave at least 10 seconds between status checks.',
        'If other tools or automations use the same API key, their requests count toward the same limit.',
      ],
      links: [DOCS.rateLimits, DOCS.getPostOpenApi],
    }, facts);
  }

  if (httpStatus >= 500 && httpStatus <= 599) {
    return finish({
      ...base,
      headline: `Blotato's API had a server error (HTTP ${httpStatus})`,
      whatHappened: "The status check failed on Blotato's side, so the post's status is still unknown.",
      caveat: 'A server error on a status check says nothing about whether the post itself was published.',
      agentSteps: [
        'Try the check again after a short wait. Checking status only reads information, so repeating it is safe.',
        'Limit yourself to a few tries rather than retrying in a loop.',
        'Do not ask the customer to submit the post again because of this error; that risks a duplicate.',
        'If it keeps happening, escalate with the submission ID, the time of the error, and the request ID if one is shown.',
      ],
      links: [DOCS.errorsAndRetries, DOCS.getPostOpenApi, DOCS.findOutcome],
    }, facts);
  }

  return finish({
    ...base,
    headline: `Unexpected response from Blotato (HTTP ${httpStatus})`,
    whatHappened: `Blotato answered the status check with HTTP ${httpStatus}, which this tool has no explanation for. The post's status is unknown.`,
    caveat: 'This tool only explains responses described in the official docs, and will not guess what this one means.',
    agentSteps: [
      'Open Blotato Logs to see what was recorded for this request.',
      'Do not ask the customer to submit the post again while the outcome is unknown; that risks a duplicate.',
      'If the cause is unclear, escalate with the submission ID and the exact response. Never include an API key.',
    ],
    links: [DOCS.errorsAndRetries, DOCS.logs],
  }, facts);
}

/**
 * Main entry point.
 *
 * @param {object} result
 * @param {number} [result.httpStatus]    HTTP status of the Get Post response.
 * @param {*}      [result.body]          Parsed JSON body (or null).
 * @param {string} [result.networkError]  Set when the API could not be reached at all.
 * @param {object} [options]
 * @param {Date}   [options.now]          "Current time" (tests pass a fixed one).
 * @param {string} [options.requestedId]  The ID the agent typed (used when the body has none).
 */
export function diagnose(result, options = {}) {
  const now = options.now ?? new Date();
  const { httpStatus = null, body = null, networkError = null } = result ?? {};
  const bodyIsObject = body !== null && typeof body === 'object' && !Array.isArray(body);

  const facts = {
    postSubmissionId:
      (bodyIsObject && isNonEmptyString(body.postSubmissionId) && body.postSubmissionId) ||
      (isNonEmptyString(options.requestedId) ? options.requestedId : null),
    status: bodyIsObject && isNonEmptyString(body.status) ? body.status : null,
    publicUrl: bodyIsObject && isHttpUrl(body.publicUrl) ? body.publicUrl : null,
    scheduledTime: bodyIsObject && isNonEmptyString(body.scheduledTime) ? body.scheduledTime : null,
    httpStatus,
  };

  if (networkError) {
    return finish({
      outcome: 'network-error',
      tone: 'error',
      checkCompleted: false,
      headline: 'Could not reach Blotato',
      whatHappened: "This app could not connect to the Blotato API, so the post's status is unknown.",
      originalError: String(networkError),
      agentSteps: [
        'Check the internet connection of this computer, then try the check again. Checking status only reads information, so repeating it is safe.',
        'Do not ask the customer to submit the post again while the outcome is unknown; that risks a duplicate.',
      ],
      links: [DOCS.errorsAndRetries],
      replyNote: HOLDING_NOTE,
      customerReply: holdingReply(facts),
    }, facts);
  }

  if (httpStatus !== 200) {
    return diagnoseHttpError(httpStatus, body, facts);
  }

  if (bodyIsObject) {
    switch (body.status) {
      case 'published': return diagnosePublished(body, facts);
      case 'scheduled': return diagnoseScheduled(body, facts, now);
      case 'in-progress': return diagnoseInProgress(body, facts);
      case 'failed': return diagnoseFailed(body, facts);
      default: break;
    }
  }

  const statusText = facts.status ? `the status "${facts.status}"` : 'no status';
  return finish({
    outcome: 'unexpected',
    tone: 'warning',
    checkCompleted: false,
    headline: 'Unexpected answer from Blotato',
    whatHappened: `Blotato answered, but with ${statusText}. The docs only describe four statuses for this check: published, failed, in-progress, and scheduled.`,
    caveat: 'This tool only explains responses described in the official docs, and will not guess what this one means.',
    agentSteps: [
      'Look for this post in Blotato under Posts and in Logs.',
      'Do not ask the customer to submit the post again while the outcome is unknown; that risks a duplicate.',
      'If the outcome is still unclear, escalate with the submission ID and the exact response.',
    ],
    links: [DOCS.getPost, DOCS.findOutcome, DOCS.logs],
    replyNote: HOLDING_NOTE,
    customerReply: holdingReply(facts),
  }, facts);
}
