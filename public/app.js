const STORAGE_KEY = 'linklite:codes';
const MAX_SAVED = 20;

const form = document.getElementById('shorten-form');
const message = document.getElementById('message');
const table = document.getElementById('links');
const tbody = table.querySelector('tbody');
const emptyText = document.getElementById('empty');

// There are no user accounts, so "my links" are just the codes this browser created.
function loadCodes() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveCodes(codes) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(codes.slice(0, MAX_SAVED)));
  } catch {
    // private mode or storage full, the list just won't persist
  }
}

function showMessage(text, isError) {
  message.textContent = text;
  message.className = isError ? 'message error' : 'message';
}

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleString() : 'Never';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const body = { url: form.url.value.trim() };
  if (form.alias.value.trim()) body.alias = form.alias.value.trim();
  if (form.expires.value) body.expiresAt = new Date(form.expires.value).toISOString();

  try {
    const res = await fetch('/api/shorten', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (!res.ok) {
      const wait = res.status === 429 ? ` Try again in ${data.retryAfter}s.` : '';
      showMessage(data.error + wait, true);
      return;
    }

    message.className = 'message';
    message.textContent = 'Short link: ';
    const link = document.createElement('a');
    link.href = data.shortUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = data.shortUrl;
    message.appendChild(link);

    const codes = loadCodes().filter((c) => c !== data.code);
    codes.unshift(data.code);
    saveCodes(codes);
    form.reset();
    renderLinks();
  } catch {
    showMessage('Could not reach the server.', true);
  }
});

async function renderLinks() {
  const codes = loadCodes();
  const results = await Promise.all(
    codes.map(async (code) => {
      try {
        const res = await fetch(`/api/stats/${encodeURIComponent(code)}`);
        if (res.status === 404) return { code, gone: true };
        return res.ok ? await res.json() : null;
      } catch {
        return null;
      }
    })
  );

  // drop links that no longer exist (for example if the db was reset)
  const missing = results.filter((r) => r && r.gone).map((r) => r.code);
  if (missing.length) saveCodes(codes.filter((c) => !missing.includes(c)));

  const rows = results.filter((r) => r && !r.gone);
  tbody.replaceChildren(...rows.map(buildRow));
  table.hidden = rows.length === 0;
  emptyText.hidden = rows.length > 0;
}

function buildRow(link) {
  const tr = document.createElement('tr');

  const shortCell = document.createElement('td');
  const a = document.createElement('a');
  a.href = link.shortUrl;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = '/' + link.code;
  shortCell.appendChild(a);
  shortCell.append(' ');
  const statsLink = document.createElement('a');
  statsLink.href = `stats.html?code=${encodeURIComponent(link.code)}`;
  statsLink.textContent = 'stats';
  statsLink.className = 'muted';
  shortCell.appendChild(statsLink);

  const originalCell = document.createElement('td');
  originalCell.className = 'original';
  originalCell.textContent = link.url;
  originalCell.title = link.url;

  const clicksCell = document.createElement('td');
  clicksCell.textContent = link.clicks;

  const expiresCell = document.createElement('td');
  expiresCell.textContent = link.expired ? 'Expired' : formatDate(link.expiresAt);
  if (link.expired) expiresCell.className = 'expired';

  tr.append(shortCell, originalCell, clicksCell, expiresCell);
  return tr;
}

document.getElementById('refresh').addEventListener('click', renderLinks);
// clicks happen in other tabs, so refresh the counts when the user comes back
window.addEventListener('focus', renderLinks);

renderLinks();
