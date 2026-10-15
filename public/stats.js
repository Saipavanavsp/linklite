const statusText = document.getElementById('status');
const details = document.getElementById('details');
const code = new URLSearchParams(window.location.search).get('code');

async function loadStats() {
  if (!code) {
    statusText.textContent = 'No link code given.';
    return;
  }

  try {
    const res = await fetch(`/api/stats/${encodeURIComponent(code)}`);
    const data = await res.json();
    if (!res.ok) {
      statusText.textContent = data.error;
      return;
    }

    const short = document.getElementById('short');
    short.href = data.shortUrl;
    short.textContent = data.shortUrl;
    document.getElementById('original').textContent = data.url;
    document.getElementById('clicks').textContent = data.clicks;
    document.getElementById('created').textContent = new Date(data.createdAt).toLocaleString();

    const expires = document.getElementById('expires');
    if (!data.expiresAt) {
      expires.textContent = 'Never';
    } else {
      expires.textContent = new Date(data.expiresAt).toLocaleString() + (data.expired ? ' (expired)' : '');
      if (data.expired) expires.className = 'expired';
    }

    statusText.hidden = true;
    details.hidden = false;
  } catch {
    statusText.textContent = 'Could not reach the server.';
  }
}

loadStats();
