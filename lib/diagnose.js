// The "doctor" part of the app.
//
// Input:  the raw answer from Blotato's "Get Post" endpoint
//         (GET https://backend.blotato.com/v2/posts/:postSubmissionId).
// Output: a plain-language diagnosis: what happened, why (only when known),
//         what to do next, and a support reply draft.
//
// Ground rules, taken from the official docs and from the project brief:
//   - Only four statuses are documented: published, failed, in-progress, scheduled.
//   - "in-progress" does not prove the ID is valid (the API returns it for unknown IDs too).
//   - "scheduled" is not "published".
//   - Never tell the user to simply resubmit: that risks a duplicate post.
//   - If a failed post's errorMessage is not in the catalog, show the original
//     text, say it is not recognized, and do NOT guess a cause.

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

const NO_BLIND_RETRY = 'Do not submit the post again while the outcome is unknown; that risks a duplicate post.';

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
    if (entry.matchAny.some((needle) => haystack.includes(normalize(needle)))) {
      return entry;
    }
  }
  return null;
}

/** Builds a plain-text reply a support person could send to the customer. */
export function buildSupportReply(d) {
  const id = d.facts.postSubmissionId;
  const idPart = id ? ` (submission ID: ${id})` : '';
  const lines = ['Hi there,', ''];

  if (d.checkCompleted) {
    lines.push(`Thanks for reaching out. I checked the status of your post${idPart}.`);
  } else {
    lines.push(`Thanks for reaching out. I tried to check the status of your post${idPart}, but the check itself did not go through.`);
  }
  lines.push('', d.whatHappened);

  if (d.originalError) {
    lines.push('', `The exact message returned was: "${d.originalError}"`);
  }
  if (d.why) {
    lines.push('', `Why: ${d.why}`);
  }
  const caveat = d.replyCaveat ?? d.caveat;
  if (caveat) {
    lines.push('', caveat);
  }
  if (d.nextSteps.length > 0) {
    lines.push('', 'What to do next:');
    d.nextSteps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  }
  lines.push(
    '',
    'If anything is unclear, or it still does not work after these steps, reply here and we will look into it further.',
    '',
    'Best regards,',
    '[Your name]',
  );
  return lines.join('\n');
}

// Fills in defaults and attaches the support reply.
function finish(partial, facts) {
  const diagnosis = {
    outcome: partial.outcome,
    tone: partial.tone,
    checkCompleted: partial.checkCompleted ?? true,
    headline: partial.headline,
    whatHappened: partial.whatHappened,
    why: partial.why ?? null,
    caveat: partial.caveat ?? null,
    recognized: partial.recognized ?? null,
    category: partial.category ?? null,
    catalogEntryId: partial.catalogEntryId ?? null,
    originalError: partial.originalError ?? null,
    nextSteps: partial.nextSteps ?? [],
    links: partial.links ?? [],
    facts,
  };
  diagnosis.supportReply = buildSupportReply({ ...diagnosis, replyCaveat: partial.replyCaveat });
  return diagnosis;
}

function diagnosePublished(body, facts) {
  if (facts.publicUrl) {
    return finish({
      outcome: 'published',
      tone: 'success',
      headline: 'Published',
      whatHappened: `Blotato recorded this post as published. Public URL: ${facts.publicUrl}`,
      nextSteps: [
        'Open the public URL and confirm the post appears on the intended account. If it does, you are done.',
        'If the link does not open or the post is missing, do not publish a replacement yet. An inaccessible URL alone does not prove the post was deleted or blocked. Keep the submission ID and contact Blotato support.',
      ],
      links: [DOCS.findOutcome, DOCS.postLifecycle],
    }, facts);
  }
  return finish({
    outcome: 'published',
    tone: 'success',
    headline: 'Published (no public URL returned)',
    whatHappened: 'Blotato recorded this post as published, but did not return a public URL for it. The docs say that field is optional.',
    nextSteps: [
      'Check the destination account on the platform itself to confirm the post is there.',
      'You can also look for it in Blotato under Posts > Published.',
      'If you cannot find it, do not publish a replacement yet. A missing URL alone does not prove the post was deleted or blocked. Keep the submission ID and contact Blotato support.',
    ],
    links: [DOCS.findOutcome, DOCS.postLifecycle],
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
      nextSteps: [
        'Look up the post in Blotato under Posts > Scheduled to see its publish time.',
        'Check this ID again after that time to confirm it was published.',
      ],
      links,
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
      replyCaveat: 'The status response does not say why it still shows as scheduled, so I do not want to guess.',
      nextSteps: [
        'Look for this post in Blotato under Posts, using the Scheduled, Published, and Failed filters.',
        'Check the destination account on the platform as well.',
        NO_BLIND_RETRY,
        'If those checks do not settle it, contact Blotato support with the submission ID and the scheduled time.',
      ],
      links,
    }, facts);
  }

  return finish({
    outcome: 'scheduled',
    tone: 'info',
    headline: 'Scheduled - not published yet',
    whatHappened: `This post is scheduled for ${whenText}. It has not been published yet.`,
    nextSteps: [
      'Nothing needs fixing. The post is waiting for its scheduled time.',
      'Check this ID again after that time to confirm it was published.',
      'To change or cancel it, edit the scheduled post in Blotato (Posts > Scheduled).',
    ],
    links,
  }, facts);
}

function diagnoseInProgress(body, facts) {
  return finish({
    outcome: 'in-progress',
    tone: 'waiting',
    headline: 'No final result yet',
    whatHappened: 'Blotato has no published, failed, or scheduled result for this ID yet.',
    caveat: 'The API returns "in-progress" both while a post is still being processed and when no record matches the ID at all. So this answer does not prove the ID is valid.',
    nextSteps: [
      'Confirm the ID is the postSubmissionId from the original create response, not a schedule ID or a published-post ID.',
      'Confirm the API key belongs to the same Blotato account that created the post.',
      'Check again, waiting at least 10 seconds between checks, and stop after a couple of minutes.',
      'If it is still in progress after that, keep the ID and look in Blotato under Posts and Logs, or contact support. Reaching the time limit is not proof that the post failed.',
      NO_BLIND_RETRY,
    ],
    links: [DOCS.getPost, DOCS.findOutcome, DOCS.logs],
  }, facts);
}

function diagnoseFailed(body, facts) {
  // Deliberately does not say "nothing was posted": the docs warn that an error
  // alone does not prove nothing reached the platform.
  const whatHappened = 'Blotato marked this post as failed: publishing stopped and an error was reported.';
  const genericSteps = [
    'Open the failed request in Blotato Logs to see the full payload, response, and error.',
    'Do not submit the same post again unchanged. The docs warn that an unchanged retry often fails for the same reason.',
    'If the cause is still unclear, contact Blotato support with the submission ID and the exact error text. Never include your API key.',
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
      replyCaveat: 'The status response did not include an error message, so I do not want to guess at the cause.',
      nextSteps: genericSteps,
      links: genericLinks,
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
      replyCaveat: 'This exact error is not in my list of known errors yet, so I do not want to guess at the cause.',
      nextSteps: [
        genericSteps[0],
        'Search the Blotato Error Reference for the exact error text.',
        genericSteps[1],
        genericSteps[2],
      ],
      links: genericLinks,
    }, facts);
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
    originalError,
    nextSteps: entry.nextSteps,
    links: entry.links,
  }, facts);
}

function diagnoseHttpError(httpStatus, body, facts) {
  const apiMessage = body && typeof body === 'object' && isNonEmptyString(body.message) ? body.message : null;
  const base = { outcome: 'http-error', tone: 'error', checkCompleted: false, originalError: apiMessage };

  if (httpStatus === 401) {
    return finish({
      ...base,
      headline: 'Blotato rejected the API key (HTTP 401)',
      whatHappened: 'The status check was rejected before Blotato looked at the post, so nothing is known about the post itself yet.',
      why: 'Blotato returns a 401 when the API key is missing or not valid.',
      nextSteps: [
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
      why: 'The docs connect a 403 from the API to subscription status: API access needs an active paid plan.',
      caveat: 'This tool cannot see your billing status, so it cannot confirm that this is the reason.',
      replyCaveat: 'I cannot see the billing status from here, so please treat this as the first thing to check rather than a confirmed cause.',
      nextSteps: [
        'Check your plan and payment status in Blotato under Settings > Billing.',
        'If the subscription is active and the 403 continues, contact Blotato support with the exact response.',
      ],
      links: [DOCS.billing, DOCS.errorsAndRetries],
    }, facts);
  }

  if (httpStatus === 404) {
    return finish({
      ...base,
      headline: 'Blotato could not find this (HTTP 404)',
      whatHappened: 'Blotato answered "not found" to the status check, so nothing is known about the post itself yet.',
      caveat: 'The Get Post docs do not describe a 404 for this endpoint (an unknown ID is normally answered with "in-progress"), so this tool cannot say exactly what was not found.',
      replyCaveat: 'The documentation does not describe this response for a status check, so I cannot say exactly what was not found.',
      nextSteps: [
        'Check the ID has no extra spaces or characters. It must be the postSubmissionId from the original create response, not a schedule ID or a published-post ID.',
        'Confirm the API key belongs to the same Blotato account that created the post.',
        'If both are right and the 404 continues, contact Blotato support with the submission ID.',
      ],
      links: [DOCS.errorsAndRetries, DOCS.getPost],
    }, facts);
  }

  if (httpStatus === 429) {
    return finish({
      ...base,
      tone: 'warning',
      headline: 'Too many status checks (HTTP 429)',
      whatHappened: 'Blotato is temporarily limiting requests from this API key, so the post was not checked this time.',
      why: 'Blotato limits this endpoint to 60 requests per minute.',
      caveat: 'This limit is about API requests only. It says nothing about whether the post itself succeeded or failed.',
      nextSteps: [
        apiMessage
          ? 'Stop checking for now. If the message above says how long to wait, wait at least that long.'
          : 'Stop checking for now and wait a minute before trying again.',
        'After that, leave at least 10 seconds between status checks.',
        'If other tools or automations use the same API key, their requests count toward the same limit.',
      ],
      links: [DOCS.rateLimits, DOCS.getPost],
    }, facts);
  }

  if (httpStatus >= 500 && httpStatus <= 599) {
    return finish({
      ...base,
      headline: `Blotato's API had a server error (HTTP ${httpStatus})`,
      whatHappened: "The status check failed on Blotato's side, so the post's status is still unknown.",
      caveat: 'A server error on a status check says nothing about whether the post itself was published.',
      nextSteps: [
        'Try the check again after a short wait. Checking status only reads information, so repeating it is safe.',
        'Limit yourself to a few tries rather than retrying in a loop.',
        NO_BLIND_RETRY,
        'If it keeps happening, contact Blotato support with the submission ID and the time of the error.',
      ],
      links: [DOCS.errorsAndRetries, DOCS.findOutcome],
    }, facts);
  }

  return finish({
    ...base,
    headline: `Unexpected response from Blotato (HTTP ${httpStatus})`,
    whatHappened: `Blotato answered the status check with HTTP ${httpStatus}, which this tool has no explanation for. The post's status is unknown.`,
    caveat: 'This tool only explains responses described in the official docs, and will not guess what this one means.',
    replyCaveat: 'This response is not described in the documentation, so I do not want to guess what it means.',
    nextSteps: [
      'Open Blotato Logs to see what was recorded for this request.',
      NO_BLIND_RETRY,
      'If the cause is unclear, contact Blotato support with the submission ID and the exact response. Never include your API key.',
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
 * @param {string} [options.requestedId]  The ID the user typed (used when the body has none).
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
      nextSteps: [
        'Check your internet connection, then try the check again. Checking status only reads information, so repeating it is safe.',
        NO_BLIND_RETRY,
      ],
      links: [DOCS.errorsAndRetries],
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
    replyCaveat: 'This response is not described in the documentation, so I do not want to guess what it means.',
    nextSteps: [
      'Look for this post in Blotato under Posts and in Logs.',
      NO_BLIND_RETRY,
      'If the outcome is still unclear, contact Blotato support with the submission ID and the exact response.',
    ],
    links: [DOCS.getPost, DOCS.findOutcome, DOCS.logs],
  }, facts);
}
