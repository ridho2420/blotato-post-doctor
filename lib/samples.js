// Sample mode: loads example API responses from the /samples folder.
// Every sample says where it came from (see the "origin" and "note" fields),
// so nobody mistakes a composed example for a captured real response.

import { readdirSync, readFileSync } from 'node:fs';

const SAMPLES_DIR = new URL('../samples/', import.meta.url);

// The order samples are shown in. Samples not listed here go at the end.
const DISPLAY_ORDER = [
  'published',
  'published-no-url',
  'scheduled',
  'scheduled-past',
  'in-progress',
  'failed-unsupported-media',
  'failed-invalid-credentials',
  'failed-account-not-authorized',
  'failed-video-too-long',
  'failed-duplicate-tweet',
  'failed-unrecognized',
  'http-401',
  'http-404',
  'http-429',
];

export const SAMPLE_ORIGINS = ['docs-verbatim', 'docs-composed', 'invented'];

function orderOf(id) {
  const index = DISPLAY_ORDER.indexOf(id);
  return index === -1 ? DISPLAY_ORDER.length : index;
}

function validate(sample, fileName) {
  const problems = [];
  if (typeof sample.id !== 'string' || sample.id === '') problems.push('missing "id"');
  if (typeof sample.label !== 'string' || sample.label === '') problems.push('missing "label"');
  if (!SAMPLE_ORIGINS.includes(sample.origin)) problems.push('"origin" must be one of ' + SAMPLE_ORIGINS.join(', '));
  if (typeof sample.note !== 'string' || sample.note === '') problems.push('missing "note"');
  if (!sample.response || !Number.isInteger(sample.response.httpStatus)) problems.push('missing "response.httpStatus"');
  if (sample.response && !('body' in sample.response)) problems.push('missing "response.body"');
  if (problems.length > 0) {
    throw new Error(`Invalid sample file ${fileName}: ${problems.join('; ')}`);
  }
}

/** Reads and checks every sample file. Returns them in display order. */
export function loadSamples() {
  const samples = [];
  const seenIds = new Set();
  for (const fileName of readdirSync(SAMPLES_DIR)) {
    if (!fileName.endsWith('.json')) continue;
    const sample = JSON.parse(readFileSync(new URL(fileName, SAMPLES_DIR), 'utf8'));
    validate(sample, fileName);
    if (seenIds.has(sample.id)) {
      throw new Error(`Duplicate sample id "${sample.id}" in ${fileName}`);
    }
    seenIds.add(sample.id);
    samples.push(sample);
  }
  samples.sort((a, b) => orderOf(a.id) - orderOf(b.id) || a.id.localeCompare(b.id));
  return samples;
}

const samples = loadSamples();

/** Short list for the UI: everything except the response itself. */
export function listSamples() {
  return samples.map(({ id, label, origin, note, sourceUrl }) => ({ id, label, origin, note, sourceUrl }));
}

/** Returns one sample by id, or null when there is no such sample. */
export function getSample(id) {
  return samples.find((sample) => sample.id === id) ?? null;
}
