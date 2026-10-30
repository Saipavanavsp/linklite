const STORAGE_KEY = 'linklite:links';
const OLD_STORAGE_KEY = 'linklite:codes';
const MAX_SAVED = 30;

const form = document.getElementById('shorten-form');
const submitButton = form.querySelector('button[type="submit"]');
const message = document.getElementById('message');
const result = document.getElementById('result');
const list = document.getElementById('links');
const emptyText = document.getElementById('empty');
const rowTemplate = document.getElementById('link-row');

document.getElementById('host-prefix').textContent = `${location.host}/`;

// a random code and a custom ending can't be combined
function syncOpaque() {
  form.alias.disabled = form.opaque.checked;
}
form.opaque.addEventListener('change', syncOpaque);
form.addEventListener('reset', () => setTimeout(syncOpaque));

// There are no accounts. "My links" are the links this browser created, saved
// with the edit key the server returned, since that key is shown only once.
function loadLinks() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved)) return saved;
    // lists saved by the older version were just codes, without keys
    const old = JSON.parse(localStorage.getItem(OLD_STORAGE_KEY)) || [];
    return old.map((code) => ({ code, token: null }));
  } catch {
    return [];
  }
}

function saveLinks(links) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(links.slice(0, MAX_SAVED)));
  } catch {
    // private mode or storage full, the list just won't persist
  }
}

function showMessage(text, isError = false) {
  message.textContent = text;
  message.className = isError ? 'message error' : 'message';
}

function errorText(res, data) {
  if (res.status === 429) return `Too many requests. Try again in ${data.retryAfter} seconds.`;
  return data.error ? data.error.charAt(0).toUpperCase() + data.error.slice(1) + '.' : `Request failed (${res.status}).`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const label = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = label), 1400);
  } catch {
    showMessage('Copying failed. Select the text and copy it by hand.', true);
  }
}

// ---- shorten ----

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const url = form.url.value.trim();
  if (!url) {
    showMessage('Paste a URL to shorten first.', true);
    form.url.focus();
    return;
  }

  const body = { url };
  if (form.alias.value.trim() && !form.opaque.checked) body.alias = form.alias.value.trim();
  if (form.expires.value) body.expiresAt = new Date(form.expires.value).toISOString();
  if (form.opaque.checked) body.opaque = true;

  submitButton.setAttribute('aria-busy', 'true');
  try {
    const res = await fetch('/api/shorten', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      showMessage(errorText(res, data), true);
      return;
    }

    showMessage('');
    showResult(data, url);
    saveLinks([{ code: data.code, token: data.manageToken }, ...loadLinks().filter((l) => l.code !== data.code)]);
    form.reset();
    renderLinks();
  } catch {
    showMessage('Could not reach the server. Check your connection and try again.', true);
  } finally {
    submitButton.removeAttribute('aria-busy');
  }
});

function showResult(data, longUrl) {
  document.getElementById('fold').textContent = longUrl;
  document.getElementById('result-dest').textContent = data.url;
  const shortLink = document.getElementById('short-link');
  shortLink.href = data.shortUrl;
  shortLink.textContent = data.shortUrl.replace(/^https?:\/\//, '');
  shortLink.dataset.copy = data.shortUrl;
  document.getElementById('result-stats').href = `stats.html?code=${encodeURIComponent(data.code)}`;
  document.getElementById('manage-token').textContent = data.manageToken;

  result.hidden = false;
  // restart the animation if a second link is made
  result.classList.remove('is-new');
  void result.offsetWidth;
  result.classList.add('is-new');
}

result.addEventListener('click', (event) => {
  const button = event.target.closest('[data-copy-target]');
  if (!button) return;
  const target = document.getElementById(button.dataset.copyTarget);
  copy(target.dataset.copy || target.textContent, button);
});

// ---- list ----

const lastCounts = new Map();

async function fetchStats(code) {
  try {
    const res = await fetch(`/api/stats/${encodeURIComponent(code)}`);
    if (res.status === 404) return { code, gone: true };
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function renderLinks() {
  const saved = loadLinks();
  const results = await Promise.all(saved.map((l) => fetchStats(l.code)));

  // forget links that no longer exist (deleted, or the demo database was reset)
  const gone = new Set(results.filter((r) => r && r.gone).map((r) => r.code));
  if (gone.size) saveLinks(saved.filter((l) => !gone.has(l.code)));

  const rows = [];
  results.forEach((stats, i) => {
    if (stats && !stats.gone) rows.push(buildRow(stats, saved[i].token));
  });
  list.replaceChildren(...rows);
  list.hidden = rows.length === 0;
  emptyText.hidden = rows.length > 0;
}

function buildRow(link, token) {
  const row = rowTemplate.content.firstElementChild.cloneNode(true);
  row.dataset.code = link.code;

  const code = row.querySelector('.row-code');
  code.href = link.shortUrl;
  code.textContent = '/' + link.code;

  const dest = row.querySelector('.row-dest');
  dest.textContent = link.url;
  dest.title = link.url;

  const meta = row.querySelector('.row-meta');
  if (link.expired) {
    meta.textContent = `Expired ${formatDate(link.expiresAt)}`;
    meta.classList.add('expired');
  } else {
    meta.textContent = link.expiresAt
      ? `Created ${formatDate(link.createdAt)}, stops working ${formatDate(link.expiresAt)}`
      : `Created ${formatDate(link.createdAt)}`;
  }

  const clicks = row.querySelector('.row-clicks');
  clicks.querySelector('strong').textContent = link.clicks;
  clicks.querySelector('span').textContent = link.clicks === 1 ? 'click' : 'clicks';
  const before = lastCounts.get(link.code);
  if (before !== undefined && link.clicks > before) clicks.classList.add('bumped');
  lastCounts.set(link.code, link.clicks);

  row.querySelector('[data-action="copy"]').dataset.url = link.shortUrl;
  row.querySelector('[data-action="stats"]').href = `stats.html?code=${encodeURIComponent(link.code)}`;

  if (!token) {
    // made by the old version of this page, before edit keys existed
    row.querySelector('[data-action="edit"]').remove();
    row.querySelector('[data-action="delete"]').remove();
  }
  row.querySelector('.row-edit input').value = link.url;
  return row;
}

function tokenFor(code) {
  const found = loadLinks().find((l) => l.code === code);
  return found && found.token;
}

function setRowNote(row, text, isError) {
  let note = row.querySelector('.row-note');
  if (!note) {
    note = document.createElement('p');
    note.setAttribute('role', 'status');
    row.appendChild(note);
  }
  note.className = isError ? 'row-note error' : 'row-note';
  note.textContent = text;
}

async function manage(code, method, body) {
  const res = await fetch(`/api/links/${encodeURIComponent(code)}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(code)}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? {} : await res.json();
  return { res, data };
}

list.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const row = button.closest('.link-row');
  const code = row.dataset.code;
  const editForm = row.querySelector('.row-edit');

  switch (button.dataset.action) {
    case 'copy':
      copy(button.dataset.url, button);
      break;

    case 'edit':
      editForm.hidden = !editForm.hidden;
      if (!editForm.hidden) editForm.querySelector('input').focus();
      break;

    case 'cancel':
      editForm.hidden = true;
      row.querySelector('[data-action="edit"]').focus();
      break;

    case 'delete':
      // first press arms the button, the second one deletes
      if (!button.classList.contains('armed')) {
        button.classList.add('armed');
        button.textContent = 'Press again to delete';
        setTimeout(() => {
          button.classList.remove('armed');
          button.textContent = 'Delete';
        }, 4000);
        return;
      }
      try {
        const { res, data } = await manage(code, 'DELETE');
        if (!res.ok && res.status !== 404) {
          setRowNote(row, errorText(res, data), true);
          return;
        }
        saveLinks(loadLinks().filter((l) => l.code !== code));
        row.remove();
        if (!list.children.length) {
          list.hidden = true;
          emptyText.hidden = false;
        }
      } catch {
        setRowNote(row, 'Could not reach the server.', true);
      }
      break;
  }
});

list.addEventListener('submit', async (event) => {
  event.preventDefault();
  const editForm = event.target;
  const row = editForm.closest('.link-row');
  const url = editForm.url.value.trim();
  try {
    const { res, data } = await manage(row.dataset.code, 'PATCH', { url });
    if (!res.ok) {
      setRowNote(row, errorText(res, data), true);
      return;
    }
    const dest = row.querySelector('.row-dest');
    dest.textContent = data.url;
    dest.title = data.url;
    editForm.hidden = true;
    setRowNote(row, 'Saved. The short link now goes to the new address.');
  } catch {
    setRowNote(row, 'Could not reach the server.', true);
  }
});

document.getElementById('refresh').addEventListener('click', renderLinks);
// clicks happen in other tabs, so refresh the counts when the user comes back
window.addEventListener('focus', renderLinks);

renderLinks();
