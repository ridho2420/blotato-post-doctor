// Review page: lists every customer reply draft so a person can read them all.

const container = document.getElementById('drafts');
const summary = document.getElementById('summary');
const messageBox = document.getElementById('message');

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.text !== undefined) node.textContent = options.text;
  if (options.className) node.className = options.className;
  for (const child of children) node.append(child);
  return node;
}

function renderDraft(draft, number) {
  const tags = [draft.source === 'sample' ? 'Sample' : 'Known error'];
  if (draft.replyKind === 'holding') tags.push('Holding reply (optional)');
  if (draft.handledBySupport) tags.push('Handled by support');

  const card = el('article', { className: 'panel draft' }, [
    el('p', { className: 'draft-tags' }, tags.map((tag) => el('span', { className: 'tag', text: tag }))),
    el('h2', { text: `${number}. ${draft.label}` }),
    el('p', { className: 'hint' }, [el('code', { text: draft.id })]),
  ]);

  if (draft.originalError) {
    card.append(
      el('h3', { text: 'Error text used' }),
      el('pre', { className: 'original-error', text: draft.originalError }),
    );
  }
  if (draft.replyNote) {
    card.append(el('p', { className: 'caveat', text: draft.replyNote }));
  }
  if (draft.beforeSending.length > 0) {
    card.append(
      el('h3', { text: 'Reminders shown to the agent' }),
      el('ul', { className: 'reminders' }, draft.beforeSending.map((text) => el('li', { text }))),
    );
  }
  card.append(
    el('h3', { text: 'What the customer would read' }),
    el('pre', { className: 'draft-text', text: draft.text }),
  );
  return card;
}

fetch('/api/drafts')
  .then((response) => response.json())
  .then(({ drafts }) => {
    const samples = drafts.filter((draft) => draft.source === 'sample');
    const known = drafts.filter((draft) => draft.source === 'catalog');
    summary.textContent = `${drafts.length} drafts: ${samples.length} samples and ${known.length} known errors.`;

    container.append(el('h2', { className: 'group-title', text: `Samples (${samples.length})` }));
    samples.forEach((draft, index) => container.append(renderDraft(draft, index + 1)));
    container.append(el('h2', { className: 'group-title', text: `Known errors (${known.length})` }));
    known.forEach((draft, index) => container.append(renderDraft(draft, samples.length + index + 1)));
  })
  .catch(() => {
    messageBox.textContent = 'Could not load the drafts. Is the server running? (npm start)';
    messageBox.hidden = false;
  });
