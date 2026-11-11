// Browser side of Blotato Post Doctor.
// It asks the local server for a diagnosis and shows it. All text is inserted
// with textContent (never innerHTML), so nothing from an API response can run as code.

const form = document.getElementById('check-form');
const sampleFields = document.getElementById('sample-fields');
const liveFields = document.getElementById('live-fields');
const sampleSelect = document.getElementById('sample-select');
const idInput = document.getElementById('id-input');
const checkButton = document.getElementById('check-button');
const messageBox = document.getElementById('message');
const resultBox = document.getElementById('result');

const ORIGIN_LABELS = {
  'docs-verbatim': 'copied from the docs',
  'docs-composed': 'built from the docs',
  'invented': 'made up for testing',
};

const PILL_LABELS = {
  'published': 'Published',
  'scheduled': 'Scheduled',
  'in-progress': 'In progress',
  'failed': 'Failed',
  'http-error': 'Check failed',
  'network-error': 'Check failed',
  'unexpected': 'Unexpected',
};

// Small helper to create an element with text and/or a class.
function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.text !== undefined) node.textContent = options.text;
  if (options.className) node.className = options.className;
  for (const child of children) node.append(child);
  return node;
}

function isWebUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function externalLink(url, label) {
  const link = el('a', { text: label ?? url });
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function currentMode() {
  return form.elements.mode.value;
}

function showMessage(text) {
  messageBox.textContent = text;
  messageBox.hidden = false;
}

function clearOutput() {
  messageBox.hidden = true;
  messageBox.textContent = '';
  resultBox.hidden = true;
  resultBox.replaceChildren();
}

function updateModeFields() {
  const live = currentMode() === 'live';
  sampleFields.hidden = live;
  liveFields.hidden = !live;
}

async function loadSamples() {
  try {
    const response = await fetch('/api/samples');
    const { samples } = await response.json();
    sampleSelect.replaceChildren();
    for (const sample of samples) {
      const option = el('option', {
        text: `${sample.label}  (${ORIGIN_LABELS[sample.origin] ?? sample.origin})`,
      });
      option.value = sample.id;
      sampleSelect.append(option);
    }
  } catch {
    showMessage('Could not load the samples. Is the server still running?');
  }
}

function addFact(list, label, valueNode) {
  list.append(el('dt', { text: label }), el('dd', {}, [valueNode]));
}

function renderFacts(facts, diagnosis) {
  const list = el('dl', { className: 'facts' });
  if (facts.postSubmissionId) addFact(list, 'Submission ID', el('code', { text: facts.postSubmissionId }));
  if (facts.status) addFact(list, 'Status from Blotato', el('code', { text: facts.status }));
  if (isWebUrl(facts.publicUrl)) addFact(list, 'Public URL', externalLink(facts.publicUrl));
  if (facts.scheduledTime) addFact(list, 'Scheduled time', el('code', { text: facts.scheduledTime }));
  if (facts.httpStatus !== null && facts.httpStatus !== undefined) {
    addFact(list, 'HTTP status', el('code', { text: String(facts.httpStatus) }));
  }
  if (diagnosis.apiRequestId) addFact(list, 'Request ID (reqId)', el('code', { text: diagnosis.apiRequestId }));
  if (diagnosis.apiSubscriptionStatus) addFact(list, 'Subscription status', el('code', { text: diagnosis.apiSubscriptionStatus }));
  return list;
}

async function copyText(text, textarea) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers: select the text and use the old copy command.
    textarea.select();
    return document.execCommand('copy');
  }
}

function renderReply(diagnosis) {
  const reply = diagnosis.customerReply;
  const holding = reply.kind === 'holding';

  const textarea = el('textarea');
  textarea.value = reply.text;
  textarea.setAttribute('aria-label', holding ? 'Holding reply draft' : 'Customer reply draft');

  const status = el('span', { className: 'copy-status' });
  status.setAttribute('role', 'status');

  const copyButton = el('button', { text: 'Copy reply', className: 'secondary' });
  copyButton.type = 'button';
  copyButton.addEventListener('click', async () => {
    const copied = await copyText(textarea.value, textarea);
    status.textContent = copied ? 'Copied.' : 'Could not copy. Select the text and copy it by hand.';
  });

  const section = el('section', { className: 'panel reply' }, [
    el('div', { className: 'reply-header' }, [
      el('h3', { text: holding ? 'Holding reply for the customer (optional)' : 'Reply draft for the customer' }),
      el('div', {}, [status, copyButton]),
    ]),
  ]);
  if (diagnosis.replyNote) {
    section.append(el('p', { className: 'caveat', text: diagnosis.replyNote }));
  }
  if (reply.beforeSending.length > 0) {
    section.append(el('ul', { className: 'reminders' }, reply.beforeSending.map((text) => el('li', { text }))));
  }
  section.append(
    textarea,
    el('p', { className: 'hint', text: 'A starting point. You can edit it here before copying. Read it before you send it.' }),
  );
  return section;
}

function renderResult(data) {
  const { diagnosis, sample, raw } = data;
  const nodes = [];

  if (sample) {
    nodes.push(el('p', { className: 'sample-banner' }, [
      el('strong', { text: `Sample (${ORIGIN_LABELS[sample.origin] ?? sample.origin}). ` }),
      document.createTextNode(sample.note),
    ]));
  }

  const card = el('article', { className: 'panel card' });
  card.dataset.tone = diagnosis.tone;
  card.append(
    el('span', { className: 'pill', text: PILL_LABELS[diagnosis.outcome] ?? diagnosis.outcome }),
    el('h2', { text: diagnosis.headline }),
    renderFacts(diagnosis.facts, diagnosis),
    el('h3', { text: 'What happened' }),
    el('p', { text: diagnosis.whatHappened }),
  );

  if (diagnosis.originalError) {
    card.append(
      el('h3', { text: 'Exact message from Blotato' }),
      el('pre', { className: 'original-error', text: diagnosis.originalError }),
    );
  }
  if (diagnosis.apiSuggestedAction) {
    card.append(
      el('h3', { text: 'Action suggested by Blotato' }),
      el('pre', { className: 'original-error', text: diagnosis.apiSuggestedAction }),
    );
  }
  if (diagnosis.why) {
    card.append(el('h3', { text: 'Why' }), el('p', { text: diagnosis.why }));
  }
  if (diagnosis.caveat) {
    card.append(el('p', { className: 'caveat', text: diagnosis.caveat }));
  }
  if (diagnosis.agentSteps.length > 0) {
    card.append(
      el('h3', { text: 'What you (the support agent) should do' }),
      el('ol', { className: 'steps' }, diagnosis.agentSteps.map((step) => el('li', { text: step }))),
    );
  }
  const links = diagnosis.links.filter((link) => isWebUrl(link.url));
  if (links.length > 0) {
    card.append(
      el('h3', { text: 'Related help pages' }),
      el('ul', { className: 'links' }, links.map((link) => el('li', {}, [externalLink(link.url, link.label)]))),
    );
  }
  nodes.push(card);

  nodes.push(renderReply(diagnosis));

  nodes.push(el('details', {}, [
    el('summary', { text: 'Raw response this diagnosis is based on' }),
    el('pre', { text: JSON.stringify(raw, null, 2) }),
  ]));

  resultBox.replaceChildren(...nodes);
  resultBox.hidden = false;
}

async function checkPost(event) {
  event.preventDefault();
  clearOutput();

  const mode = currentMode();
  const id = mode === 'live' ? idInput.value.trim() : sampleSelect.value;
  if (!id) {
    showMessage(mode === 'live' ? 'Enter a post submission ID first.' : 'Choose a sample first.');
    return;
  }

  checkButton.disabled = true;
  checkButton.textContent = 'Checking...';
  try {
    const response = await fetch(`/api/diagnose?mode=${encodeURIComponent(mode)}&id=${encodeURIComponent(id)}`);
    const data = await response.json();
    if (!response.ok || !data.diagnosis) {
      showMessage(data.error ?? `The server answered with an error (HTTP ${response.status}).`);
      return;
    }
    renderResult(data);
  } catch {
    showMessage('Could not reach the local server. Is it still running? (npm start)');
  } finally {
    checkButton.disabled = false;
    checkButton.textContent = 'Check post';
  }
}

for (const radio of form.elements.mode) {
  radio.addEventListener('change', () => {
    updateModeFields();
    clearOutput();
  });
}
form.addEventListener('submit', checkPost);

updateModeFields();
loadSamples();
