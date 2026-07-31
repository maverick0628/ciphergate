/*
 * CipherGate UI.
 *
 * Three non-negotiables in here:
 *
 *   1. Nothing is ever written to localStorage, sessionStorage or the URL. The
 *      session lives in an httpOnly cookie this script cannot read, and secret
 *      values exist only for as long as the input holding them.
 *
 *   2. Every value that came from the server reaches the DOM through
 *      textContent, never innerHTML. Tags, descriptions and consumer names are
 *      free text, and this page is rendered by whoever holds the keys.
 *
 *   3. A secret is read-only until you say otherwise. Editing is a mode you
 *      enter deliberately, and replacing a value is a further step inside it.
 */

'use strict';

// ── DOM helpers ─────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

/** Build an element. `text` always goes through textContent. */
function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v !== null && v !== undefined && v !== false) node.setAttribute(k, String(v));
    }
  }
  if (opts.on) {
    for (const [event, handler] of Object.entries(opts.on)) node.addEventListener(event, handler);
  }
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

let toastTimer;
function toast(message, isError = false) {
  const node = $('toast');
  node.textContent = message;
  node.classList.toggle('is-error', isError);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 6000 : 2600);
}

/**
 * Copy to the clipboard. Only ever used for commands, never for secret values.
 * The async clipboard API needs a secure context, and a self-signed certificate
 * that the browser has not been told to trust does not always qualify — so fall
 * back to the old selection trick rather than failing silently.
 */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  const scratch = el('textarea', { attrs: { readonly: 'readonly' } });
  scratch.value = text;
  scratch.style.position = 'fixed';
  scratch.style.opacity = '0';
  document.body.appendChild(scratch);
  scratch.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(scratch);
  return ok;
}

// ── API ─────────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, body) {
    super((body && body.message) || `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
  });

  if (res.status === 401) {
    showLogin('Session expired. Log in to continue.');
    throw new ApiError(401, { message: 'Session expired' });
  }

  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

// ── Console ─────────────────────────────────────────────────────────────────

/*
 * Everything the CLI can do that this interface deliberately does not. The
 * "why" matters as much as the command: it separates "lives elsewhere on
 * purpose" from "someone forgot to build it".
 *
 * Commands are shown in their generic in-container form. No addresses, no
 * usernames — wrap them in whatever gets you to your own host.
 */
const CONSOLE_GROUPS = [
  {
    title: 'Consumers',
    items: [
      {
        name: 'Add a consumer',
        why: 'Prints the API key exactly once and never again, so it needs a terminal you are watching.',
        cmd: 'docker exec -it ciphergate gateway consumer add <name>',
      },
      {
        name: 'Revoke a consumer',
        why: 'Immediately refuses every request carrying that key.',
        cmd: 'docker exec -it ciphergate gateway consumer revoke <name>',
      },
      {
        name: 'Rotate a consumer key',
        why: 'Issues a replacement key and invalidates the old one. Printed once.',
        cmd: 'docker exec -it ciphergate gateway consumer rotate-key <name>',
      },
    ],
  },
  {
    title: 'Secrets',
    items: [
      {
        name: 'Read a real value',
        why: 'No endpoint behind this interface returns plaintext, so a stolen session yields metadata and eight characters. Reading a value is a CLI or MCP operation.',
        cmd: 'docker exec -it ciphergate gateway secret get <NAME>',
      },
      {
        name: 'Delete a secret',
        why: 'Irreversible, and history records that a change happened rather than the value it replaced. A GUI makes actions easy, which is the last property this one needs.',
        cmd: 'docker exec -it ciphergate gateway secret delete <NAME>',
      },
      {
        name: 'Export as dotenv',
        why: 'Writes every value this consumer can read to stdout in the clear.',
        cmd: 'docker exec -it ciphergate gateway env --consumer <name>',
      },
      {
        name: 'Bulk import',
        why: 'Reads a YAML seed file from the host that owns the database.',
        cmd: 'docker exec -it ciphergate gateway import <path.yaml>',
      },
    ],
  },
  {
    title: 'Operations',
    items: [
      {
        name: 'Audit log',
        why: 'Every read, write and auth failure, with the consumer and address behind it.',
        cmd: 'docker exec -it ciphergate gateway audit --limit 50',
      },
      {
        name: 'Rotation report',
        why: 'The full picture behind the dots in the list, including ages and policies.',
        cmd: 'docker exec -it ciphergate gateway rotation-report',
      },
      {
        name: 'Back up the database',
        why: 'Operates on the SQLite file directly, so it runs where the file is.',
        cmd: 'docker exec -it ciphergate gateway backup --output /data/backup.db',
      },
      {
        name: 'Restore from a backup',
        why: 'Replaces the live database. Stop consumers first.',
        cmd: 'docker exec -it ciphergate gateway restore /data/backup.db',
      },
    ],
  },
  {
    title: 'This interface',
    items: [
      {
        name: 'Change the UI password',
        why: 'The credential gating this page. Prompted twice, never accepted as a flag.',
        cmd: 'docker exec -it ciphergate gateway ui set-password',
      },
    ],
  },
];

function renderConsole() {
  const body = $('console-body');
  clear(body);

  for (const group of CONSOLE_GROUPS) {
    body.appendChild(el('h3', { class: 'console-group-title', text: group.title }));

    for (const item of group.items) {
      const cmd = el('pre', { class: 'console-cmd', text: item.cmd });
      const copyBtn = el('button', {
        class: 'btn btn-sm',
        text: 'Copy',
        attrs: { type: 'button' },
        on: {
          click: async (event) => {
            const ok = await copyText(item.cmd);
            const button = event.currentTarget;
            button.textContent = ok ? 'Copied' : 'Copy failed';
            setTimeout(() => { button.textContent = 'Copy'; }, 1600);
          },
        },
      });

      body.appendChild(
        el('div', { class: 'console-item' }, [
          el('div', { class: 'console-item-head' }, [
            el('h4', { class: 'console-item-title', text: item.name }),
          ]),
          el('p', { class: 'console-why', text: item.why }),
          el('div', { class: 'console-cmd-row' }, [cmd, copyBtn]),
        ]),
      );
    }
  }
}

function openConsole() {
  renderConsole();
  $('console-overlay').hidden = false;
  $('console-close').focus();
}

function closeConsole() {
  $('console-overlay').hidden = true;
}

// ── State ───────────────────────────────────────────────────────────────────

const state = {
  secrets: [],
  consumers: [],
  allTags: [],
  selected: null,
  detail: null,
  mode: 'view',
  search: '',
  tag: '',
};

const ROTATION_LABEL = {
  none: 'no rotation policy',
  ok: 'rotation ok',
  due_soon: 'rotation due soon',
  overdue: 'rotation overdue',
};

// ── Views ───────────────────────────────────────────────────────────────────

function showLogin(message) {
  $('app-view').hidden = true;
  $('login-view').hidden = false;
  closeConsole();
  const err = $('login-error');
  if (message) {
    err.textContent = message;
    err.hidden = false;
  } else {
    err.hidden = true;
  }
  $('login-password').value = '';
}

function showApp(user) {
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  $('session-user').textContent = user;
}

// ── List ────────────────────────────────────────────────────────────────────

function visibleSecrets() {
  const needle = state.search.trim().toLowerCase();
  if (!needle) return state.secrets;
  return state.secrets.filter((s) => {
    const haystack = [s.name, s.description || '', ...(s.tags || []), ...(s.consumers || [])]
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

function renderLegend() {
  const legend = $('rotation-legend');
  clear(legend);
  for (const [cls, label] of [['ok', 'watched'], ['overdue', 'overdue'], ['none', 'no policy']]) {
    legend.appendChild(
      el('span', {}, [el('i', { class: `dot ${cls}` }), el('span', { text: label })]),
    );
  }
}

function renderList() {
  const list = $('secret-list');
  clear(list);

  const items = visibleSecrets();
  $('list-count').textContent = `${items.length} secret${items.length === 1 ? '' : 's'}`;

  if (items.length === 0) {
    list.appendChild(el('li', { class: 'empty-list', text: 'Nothing matches.' }));
    return;
  }

  for (const secret of items) {
    const s = secret.rotation_state || 'none';
    const tags = (secret.tags || []).slice(0, 4).map((t) => el('span', { class: 'chip', text: t }));

    list.appendChild(
      el(
        'li',
        {
          class: `secret-item${state.selected === secret.name ? ' is-active' : ''}`,
          attrs: { tabindex: '0', role: 'button' },
          on: {
            click: () => selectSecret(secret.name),
            keydown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                selectSecret(secret.name);
              }
            },
          },
        },
        [
          el('div', { class: 'secret-item-top' }, [
            el('span', { class: `dot ${s}`, attrs: { title: ROTATION_LABEL[s] } }),
            el('span', { class: 'secret-name', text: secret.name }),
          ]),
          tags.length ? el('div', { class: 'secret-item-tags' }, tags) : null,
        ],
      ),
    );
  }
}

function renderTagFilter() {
  const select = $('tag-filter');
  const current = select.value;
  clear(select);
  select.appendChild(el('option', { text: 'All tags', attrs: { value: '' } }));
  for (const tag of state.allTags) {
    select.appendChild(el('option', { text: tag, attrs: { value: tag } }));
  }
  select.value = current;
}

// ── Detail: shared pieces ───────────────────────────────────────────────────

function fact(label, value) {
  return el('span', { class: 'fact' }, [
    el('strong', { text: `${label} ` }),
    el('span', { text: value }),
  ]);
}

function section(title, children) {
  return el('div', { class: 'section' }, [
    el('h2', { class: 'section-title', text: title }),
    ...children,
  ]);
}

function consolePointer(text) {
  return el('p', { class: 'field-hint' }, [
    el('span', { text: `${text} ` }),
    el('a', {
      text: 'Open the console',
      attrs: { href: '#', role: 'button' },
      on: {
        click: (e) => {
          e.preventDefault();
          openConsole();
        },
      },
    }),
    el('span', { text: '.' }),
  ]);
}

function historySection(history) {
  return section(
    'History',
    history.length
      ? [
          el('table', { class: 'history' }, [
            el('thead', {}, [
              el('tr', {}, [
                el('th', { text: 'Version' }),
                el('th', { text: 'Changed' }),
                el('th', { text: 'By' }),
              ]),
            ]),
            el(
              'tbody',
              {},
              history
                .slice()
                .reverse()
                .map((h) =>
                  el('tr', {}, [
                    el('td', { text: String(h.version) }),
                    el('td', { text: h.changed_at }),
                    el('td', { text: h.changed_by }),
                  ]),
                ),
            ),
          ]),
        ]
      : [el('p', { class: 'history-empty', text: 'No previous versions.' })],
  );
}

function detailHead(detail, actions) {
  const s = detail.rotation_state || 'none';
  return el('div', { class: 'detail-head' }, [
    el('div', {}, [
      el('h1', { class: 'detail-title', text: detail.name }),
      el('div', { class: 'detail-facts' }, [
        fact('version', String(detail.version)),
        fact('updated', detail.updated_at),
        fact('rotation', ROTATION_LABEL[s]),
      ]),
    ]),
    el('div', { class: 'detail-actions' }, actions),
  ]);
}

// ── Detail: read-only ───────────────────────────────────────────────────────

function renderDetail(detail) {
  state.detail = detail;
  state.mode = 'view';

  const root = $('detail');
  clear(root);
  const inner = el('div', { class: 'detail-inner' });

  const editBtn = el('button', {
    class: 'btn btn-primary',
    text: 'Edit',
    attrs: { type: 'button' },
    on: { click: () => renderEdit(detail) },
  });

  inner.appendChild(detailHead(detail, [editBtn]));

  inner.appendChild(
    section('Stored value', [
      el('span', { class: 'mask', text: detail.masked }),
      consolePointer('Masked preview. The full value is never sent to this page.'),
    ]),
  );

  inner.appendChild(
    section('Description', [
      detail.description
        ? el('p', { class: 'readonly-text', text: detail.description })
        : el('p', { class: 'readonly-text readonly-empty', text: 'No description.' }),
    ]),
  );

  const tags = detail.tags || [];
  inner.appendChild(
    section('Tags', [
      tags.length
        ? el('div', { class: 'readonly-chips' }, tags.map((t) => el('span', { class: 'chip', text: t })))
        : el('p', { class: 'readonly-text readonly-empty', text: 'No tags.' }),
    ]),
  );

  const consumers = detail.consumers || [];
  inner.appendChild(
    section('Consumers', [
      consumers.length
        ? el('ul', { class: 'readonly-list' }, consumers.map((c) => el('li', { class: 'chip', text: c })))
        : el('p', { class: 'readonly-text readonly-empty', text: 'No consumer can read this secret.' }),
      consolePointer('Consumers are created on the CLI, not here.'),
    ]),
  );

  inner.appendChild(
    section('Rotation policy', [
      el('p', {
        class: detail.rotation_days == null ? 'readonly-text readonly-empty' : 'readonly-text',
        text:
          detail.rotation_days == null
            ? 'No policy. Nothing is checking how old this secret is.'
            : `Every ${detail.rotation_days} days — currently ${ROTATION_LABEL[detail.rotation_state || 'none']}.`,
      }),
    ]),
  );

  inner.appendChild(historySection(detail.history || []));
  root.appendChild(inner);
}

// ── Detail: edit ────────────────────────────────────────────────────────────

/** The rotate compartment: shut by default, and the only control that can replace a credential. */
function rotateBlock(isNew) {
  const input = el('input', {
    class: 'mono-input',
    attrs: {
      type: 'password',
      id: 'value-input',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: isNew ? 'Paste the secret value' : 'Paste the replacement value',
    },
  });

  const toggleReveal = el('button', {
    class: 'btn btn-sm',
    attrs: { type: 'button', 'aria-label': 'Show or hide what you are typing' },
    text: 'Show',
    on: {
      click: (e) => {
        const showing = input.getAttribute('type') === 'text';
        input.setAttribute('type', showing ? 'password' : 'text');
        e.currentTarget.textContent = showing ? 'Show' : 'Hide';
      },
    },
  });

  const body = el('div', { class: 'rotate-body' }, [
    el('div', { class: 'value-row' }, [input, toggleReveal]),
    el('p', {
      class: 'field-hint',
      text: isNew
        ? 'Stored encrypted. It will never be shown here again — only a masked preview.'
        : 'Saving with this filled in writes a new version and archives the current one. Leave it empty to change everything else without touching the value.',
    }),
  ]);

  if (isNew) return el('div', { class: 'rotate is-open' }, [body]);

  body.hidden = true;
  const wrap = el('div', { class: 'rotate' }, [
    el(
      'button',
      {
        class: 'rotate-toggle',
        attrs: { type: 'button', 'aria-expanded': 'false' },
        on: {
          click: (e) => {
            const open = wrap.classList.toggle('is-open');
            body.hidden = !open;
            e.currentTarget.setAttribute('aria-expanded', String(open));
            if (open) input.focus();
            else input.value = '';
          },
        },
      },
      [el('span', { text: 'Rotate value' }), el('span', { class: 'rotate-caret', text: '›' })],
    ),
    body,
  ]);
  return wrap;
}

function consumerGrid(selected) {
  // Anything already on the secret stays offerable even if that consumer has
  // since been revoked, so saving cannot silently drop it.
  const names = new Set(state.consumers.map((c) => c.name));
  for (const name of selected) names.add(name);

  return el(
    'div',
    { class: 'consumer-grid' },
    [...names].sort().map((name) =>
      el('label', { class: 'check' }, [
        el('input', {
          attrs: {
            type: 'checkbox',
            value: name,
            'data-consumer': '1',
            ...(selected.includes(name) ? { checked: 'checked' } : {}),
          },
        }),
        el('span', { text: name }),
      ]),
    ),
  );
}

function collectForm() {
  const consumers = [...document.querySelectorAll('[data-consumer]')]
    .filter((box) => box.checked)
    .map((box) => box.value);

  const tags = $('tags-input').value.split(',').map((t) => t.trim()).filter(Boolean);

  const rotationRaw = $('rotation-input').value.trim();
  const rotationDays = rotationRaw === '' ? null : Number(rotationRaw);

  return {
    description: $('description-input').value.trim(),
    consumers,
    tags,
    rotation_days: Number.isInteger(rotationDays) && rotationDays > 0 ? rotationDays : null,
    value: $('value-input').value,
  };
}

function renderEdit(detail) {
  state.mode = 'edit';

  const root = $('detail');
  clear(root);
  const inner = el('div', { class: 'detail-inner' });

  const saveBtn = el('button', { class: 'btn btn-primary', text: 'Save changes', attrs: { type: 'button' } });
  const cancelBtn = el('button', {
    class: 'btn btn-ghost',
    text: 'Cancel',
    attrs: { type: 'button' },
    // Restores the read-only view from what we already hold. No request.
    on: { click: () => renderDetail(detail) },
  });

  inner.appendChild(detailHead(detail, [saveBtn, cancelBtn]));

  inner.appendChild(
    section('Stored value', [
      el('span', { class: 'mask', text: detail.masked }),
      el('p', {
        class: 'field-hint',
        text: 'Masked preview. Replacing it is a separate step below.',
      }),
    ]),
  );

  inner.appendChild(
    section('Description', [el('textarea', { attrs: { id: 'description-input', placeholder: 'What is this for?' } })]),
  );

  inner.appendChild(
    section('Tags', [
      el('input', {
        class: 'mono-input',
        attrs: { type: 'text', id: 'tags-input', placeholder: 'comma, separated', spellcheck: 'false' },
      }),
    ]),
  );

  inner.appendChild(
    section('Consumers', [
      consumerGrid(detail.consumers || []),
      consolePointer('Every consumer that should keep access must stay ticked. Creating one is a CLI operation.'),
    ]),
  );

  inner.appendChild(
    section('Rotation policy', [
      el('input', { attrs: { type: 'number', id: 'rotation-input', min: '1', placeholder: 'Days (blank for none)' } }),
      el('p', {
        class: 'field-hint',
        text: 'Blank means nothing checks this secret’s age, and it shows as "no policy" in the list.',
      }),
    ]),
  );

  inner.appendChild(section('Replace the value', [rotateBlock(false)]));

  const errorLine = el('p', { class: 'error-line' });
  errorLine.hidden = true;
  saveBtn.addEventListener('click', () => saveExisting(detail, saveBtn, errorLine));

  inner.appendChild(errorLine);
  root.appendChild(inner);

  // Values set after mount so textContent-only construction stays the rule.
  $('description-input').value = detail.description || '';
  $('tags-input').value = (detail.tags || []).join(', ');
  $('rotation-input').value = detail.rotation_days == null ? '' : String(detail.rotation_days);
}

// ── New secret ──────────────────────────────────────────────────────────────

function renderNew() {
  state.selected = null;
  state.mode = 'edit';
  renderList();

  const root = $('detail');
  clear(root);
  const inner = el('div', { class: 'detail-inner' });

  inner.appendChild(
    el('div', { class: 'detail-head' }, [
      el('div', {}, [
        el('h1', { class: 'detail-title', text: 'New secret' }),
        el('div', { class: 'detail-facts' }, [
          el('span', { class: 'fact', text: 'Uppercase letters, digits and underscores' }),
        ]),
      ]),
    ]),
  );

  inner.appendChild(
    section('Name', [
      el('input', {
        class: 'mono-input',
        attrs: { type: 'text', id: 'name-input', placeholder: 'SERVICE_API_TOKEN', spellcheck: 'false', autocomplete: 'off' },
      }),
      el('p', { class: 'field-hint', text: 'This is the contract: mcp-wrap exports the secret under exactly this name.' }),
    ]),
  );

  inner.appendChild(section('Value', [rotateBlock(true)]));

  inner.appendChild(
    section('Description', [el('textarea', { attrs: { id: 'description-input', placeholder: 'What is this for?' } })]),
  );

  inner.appendChild(
    section('Tags', [
      el('input', {
        class: 'mono-input',
        attrs: { type: 'text', id: 'tags-input', placeholder: 'comma, separated', spellcheck: 'false' },
      }),
    ]),
  );

  inner.appendChild(
    section('Consumers', [
      consumerGrid([]),
      consolePointer('A secret with no consumer is invisible to mcp-wrap.'),
    ]),
  );

  inner.appendChild(
    section('Rotation policy', [
      el('input', { attrs: { type: 'number', id: 'rotation-input', min: '1', placeholder: 'Days (blank for none)' } }),
    ]),
  );

  const createBtn = el('button', { class: 'btn btn-primary', text: 'Create secret', attrs: { type: 'button' } });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: 'Cancel', attrs: { type: 'button' }, on: { click: () => showEmpty() } });
  const errorLine = el('p', { class: 'error-line' });
  errorLine.hidden = true;
  createBtn.addEventListener('click', () => createSecret(createBtn, errorLine));

  inner.appendChild(el('div', { class: 'actions' }, [createBtn, cancelBtn]));
  inner.appendChild(errorLine);
  root.appendChild(inner);
  $('name-input').focus();
}

function showEmpty() {
  state.selected = null;
  state.detail = null;
  state.mode = 'view';
  renderList();
  const root = $('detail');
  clear(root);
  root.appendChild(
    el('div', { class: 'empty-state' }, [
      el('p', { text: 'Select a secret to view it, or create a new one.' }),
    ]),
  );
}

function showError(line, message) {
  line.textContent = message;
  line.hidden = false;
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function selectSecret(name) {
  state.selected = name;
  renderList();
  try {
    renderDetail(await api(`/api/secrets/${encodeURIComponent(name)}`));
  } catch (err) {
    if (err.status !== 401) toast(err.message, true);
  }
}

async function saveExisting(detail, button, errorLine) {
  const form = collectForm();
  errorLine.hidden = true;
  button.disabled = true;

  const payload = {
    description: form.description,
    consumers: form.consumers,
    tags: form.tags,
    rotation_days: form.rotation_days,
    expected_version: detail.version,
  };

  // Omitted entirely unless a replacement was actually typed. This is what makes
  // editing metadata unable to touch the stored value.
  if (form.value !== '') payload.value = form.value;

  try {
    await api(`/api/secrets/${encodeURIComponent(detail.name)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    toast(form.value !== '' ? `${detail.name} rotated` : `${detail.name} updated`);
    await refresh();
    await selectSecret(detail.name);
  } catch (err) {
    if (err.status === 409) {
      showError(errorLine, `${err.message} Reload the secret before saving again.`);
    } else if (err.status !== 401) {
      showError(errorLine, err.message);
    }
  } finally {
    button.disabled = false;
  }
}

async function createSecret(button, errorLine) {
  const name = $('name-input').value.trim();
  const form = collectForm();
  errorLine.hidden = true;

  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) {
    showError(errorLine, 'Name must be uppercase letters, digits and underscores, starting with a letter.');
    return;
  }
  if (form.value === '') {
    showError(errorLine, 'A value is required.');
    return;
  }

  button.disabled = true;
  try {
    await api('/api/secrets', {
      method: 'POST',
      body: JSON.stringify({
        name,
        value: form.value,
        description: form.description,
        consumers: form.consumers,
        tags: form.tags,
        rotation_days: form.rotation_days,
      }),
    });
    toast(`${name} created`);
    await refresh();
    await selectSecret(name);
  } catch (err) {
    if (err.status !== 401) showError(errorLine, err.message);
  } finally {
    button.disabled = false;
  }
}

async function refresh() {
  const query = state.tag ? `?tag=${encodeURIComponent(state.tag)}` : '';
  const data = await api(`/api/secrets${query}`);
  state.secrets = data.secrets || [];

  if (!state.tag) {
    const tags = new Set();
    for (const secret of state.secrets) for (const tag of secret.tags || []) tags.add(tag);
    state.allTags = [...tags].sort();
    renderTagFilter();
  }

  renderList();
}

async function start(user) {
  showApp(user);
  renderLegend();
  const consumerData = await api('/api/consumers');
  state.consumers = consumerData.consumers || [];
  await refresh();
  showEmpty();
}

// ── Wiring ──────────────────────────────────────────────────────────────────

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const err = $('login-error');
  err.hidden = true;

  const user = $('login-user').value.trim();
  const password = $('login-password').value;

  try {
    const res = await fetch('/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user, password }),
    });

    // Cleared whatever happens — no reason to keep it in the field.
    $('login-password').value = '';

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      err.textContent =
        res.status === 503
          ? 'No UI password is set. Run: gateway ui set-password'
          : (body && body.message) || 'Login failed.';
      err.hidden = false;
      return;
    }

    await start((await res.json()).user);
  } catch {
    err.textContent = 'Could not reach the gateway.';
    err.hidden = false;
  }
});

$('logout-btn').addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST', credentials: 'same-origin' });
  state.secrets = [];
  state.selected = null;
  state.detail = null;
  showLogin();
});

$('new-btn').addEventListener('click', () => renderNew());
$('console-btn').addEventListener('click', () => openConsole());
$('console-close').addEventListener('click', () => closeConsole());

$('console-overlay').addEventListener('click', (event) => {
  if (event.target === $('console-overlay')) closeConsole();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('console-overlay').hidden) closeConsole();
});

$('search').addEventListener('input', (event) => {
  state.search = event.target.value;
  renderList();
});

$('tag-filter').addEventListener('change', async (event) => {
  state.tag = event.target.value;
  try {
    await refresh();
  } catch (err) {
    if (err.status !== 401) toast(err.message, true);
  }
});

// ── Boot ────────────────────────────────────────────────────────────────────

(async function boot() {
  try {
    await start((await api('/api/session')).user);
  } catch {
    showLogin();
  }
})();
