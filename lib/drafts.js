// Builds every customer reply draft the app can produce, for human review:
// one per sample, plus one per catalog entry (using the entry's example error text).
// Automated tests only catch phrases someone thought to list; this lets a person read them all.

import { catalog, diagnose } from './diagnose.js';
import { getSample, listSamples } from './samples.js';

const EXAMPLE_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function toDraft(source, id, label, diagnosis) {
  return {
    source,
    id,
    label,
    headline: diagnosis.headline,
    originalError: diagnosis.originalError,
    handledBySupport: diagnosis.handledBySupport === true,
    replyKind: diagnosis.customerReply.kind,
    replyNote: diagnosis.replyNote,
    beforeSending: diagnosis.customerReply.beforeSending,
    text: diagnosis.customerReply.text,
  };
}

export function buildAllDrafts(options = {}) {
  const now = options.now ?? new Date();
  const drafts = [];

  for (const { id, label } of listSamples()) {
    drafts.push(toDraft('sample', id, label, diagnose(getSample(id).response, { now })));
  }

  for (const entry of catalog.entries) {
    const response = {
      httpStatus: 200,
      body: { postSubmissionId: EXAMPLE_ID, status: 'failed', errorMessage: entry.example },
    };
    drafts.push(toDraft('catalog', entry.id, entry.title, diagnose(response, { now })));
  }

  return drafts;
}
