// Live mode: one read-only call to Blotato's "Get Post" endpoint.
//
//   GET https://backend.blotato.com/v2/posts/:postSubmissionId
//   header: blotato-api-key: <key>
//
// This module never creates, edits, or resubmits posts, and never polls on its own:
// one call per check that the support agent asks for.
//
// NOTE: written from the official docs only. It has NOT been run against the real
// Blotato API yet (the API needs a paid plan). The automated tests use a fake server.

export const DEFAULT_BASE_URL = 'https://backend.blotato.com/v2';
const DEFAULT_TIMEOUT_MS = 15_000;

// The ID goes into the URL path, so only allow characters a submission ID uses
// (the docs show UUIDs). This also blocks "../" and similar.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidSubmissionId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

// Replaces any copy of the API key inside a value with "[redacted]", in case an
// upstream message ever echoes it. The key must never reach the browser.
export function redactKey(value, apiKey) {
  if (!apiKey) return value;
  const text = JSON.stringify(value);
  if (text === undefined || !text.includes(apiKey)) return value;
  return JSON.parse(text.split(apiKey).join('[redacted]'));
}

/**
 * Asks Blotato for the status of one post submission.
 *
 * Resolves to one of:
 *   { httpStatus, body, bodyWasJson }   Blotato answered (any HTTP status)
 *   { networkError }                    Blotato could not be reached, or timed out
 * Never throws for HTTP errors.
 */
export async function fetchPostStatus(postSubmissionId, options) {
  const {
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  if (!isValidSubmissionId(postSubmissionId)) {
    throw new Error('Invalid submission ID.');
  }
  if (!apiKey) {
    throw new Error('No API key.');
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/posts/${encodeURIComponent(postSubmissionId)}`;

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'blotato-api-key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError'
      ? `No answer from Blotato within ${Math.round(timeoutMs / 1000)} seconds.`
      : 'The request to Blotato failed before an answer came back.';
    return { networkError: reason };
  }

  const text = await response.text();
  let body = null;
  let bodyWasJson = false;
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text);
      bodyWasJson = true;
    } catch {
      body = null;
    }
  }

  return { httpStatus: response.status, body: redactKey(body, apiKey), bodyWasJson };
}
