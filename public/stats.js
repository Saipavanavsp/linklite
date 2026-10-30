const statusText = document.getElementById('status');
const details = document.getElementById('details');
const heading = document.getElementById('code');
const code = new URLSearchParams(window.location.search).get('code');

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

async function loadStats() {
  if (!code) {
    statusText.textContent = 'No link given. Open this page from the list on the home page.';
    return;
  }

  try {
    const res = await fetch(`/api/stats/${encodeURIComponent(code)}`);
    const data = await res.json();
    if (!res.ok) {
      statusText.textContent = res.status === 404 ? `There's no link called /${code}.` : data.error;
      return;
    }

    heading.textContent = '/' + data.code;
    document.title = `/${data.code} stats - LinkLite`;

    const count = document.createElement('strong');
    count.textContent = data.clicks;
    statusText.replaceChildren(count, data.clicks === 1 ? ' click so far' : ' clicks so far');

    const short = document.getElementById('short');
    short.href = data.shortUrl;
    short.textContent = data.shortUrl;
    document.getElementById('original').textContent = data.url;
    document.getElementById('created').textContent = formatDate(data.createdAt);

    const expires = document.getElementById('expires');
    if (!data.expiresAt) {
      expires.textContent = 'Never';
    } else {
      expires.textContent = formatDate(data.expiresAt) + (data.expired ? ' (expired)' : '');
      if (data.expired) expires.className = 'expired';
    }

    details.hidden = false;
  } catch {
    statusText.textContent = 'Could not reach the server.';
  }
}

loadStats();
