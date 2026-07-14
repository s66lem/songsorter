// Spotify Web API client with Authorization Code + PKCE flow.
// Runs entirely in the browser; tokens live in localStorage.

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
].join(' ');

const store = {
  get clientId() { return localStorage.getItem('ss_client_id') || ''; },
  set clientId(v) { localStorage.setItem('ss_client_id', v); },
  get tokens() { return JSON.parse(localStorage.getItem('ss_tokens') || 'null'); },
  set tokens(v) {
    if (v) localStorage.setItem('ss_tokens', JSON.stringify(v));
    else localStorage.removeItem('ss_tokens');
  },
  get verifier() { return sessionStorage.getItem('ss_verifier') || ''; },
  set verifier(v) { sessionStorage.setItem('ss_verifier', v); },
};

function redirectUri() {
  return location.origin + location.pathname;
}

function randomString(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function sha256base64url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function setClientId(id) { store.clientId = id.trim(); }
export function getClientId() { return store.clientId; }

export function isConnected() {
  return Boolean(store.tokens?.refresh_token);
}

export async function beginLogin() {
  if (!store.clientId) throw new Error('Enter your Spotify Client ID first.');
  const verifier = randomString(64);
  store.verifier = verifier;
  const params = new URLSearchParams({
    client_id: store.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: await sha256base64url(verifier),
  });
  location.assign(`${AUTH_URL}?${params}`);
}

// Call on page load; completes the flow if we just returned from Spotify.
export async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return false;
  history.replaceState({}, '', redirectUri()); // strip ?code= from the URL
  if (error) throw new Error(`Spotify authorization failed: ${error}`);
  await fetchTokens({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: store.verifier,
  });
  return true;
}

export function logout() { store.tokens = null; }

async function fetchTokens(bodyParams) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: store.clientId, ...bodyParams }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token request failed: ${data.error_description || data.error || res.status}`);
  store.tokens = {
    access_token: data.access_token,
    // Spotify may omit a new refresh token on refresh; keep the old one.
    refresh_token: data.refresh_token || store.tokens?.refresh_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
}

async function accessToken() {
  const t = store.tokens;
  if (!t) throw new Error('Not connected to Spotify.');
  if (Date.now() >= t.expires_at) {
    await fetchTokens({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  }
  return store.tokens.access_token;
}

async function api(path, options = {}) {
  const token = await accessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (res.status === 429) {
    const wait = (Number(res.headers.get('Retry-After')) || 2) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return api(path, options);
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) store.tokens = null;
    throw new Error(data?.error?.message || `Spotify API error ${res.status}`);
  }
  return data;
}

export function me() { return api('/me'); }

export function parsePlaylistId(input) {
  const s = input.trim();
  const urlMatch = s.match(/playlist[/:]([A-Za-z0-9]{16,})/);
  if (urlMatch) return urlMatch[1];
  if (/^[A-Za-z0-9]{16,}$/.test(s)) return s;
  throw new Error('That doesn’t look like a Spotify playlist link, URI, or ID.');
}

export async function getPlaylistMeta(playlistId) {
  return api(`/playlists/${playlistId}?fields=id,name,owner(display_name),tracks(total)`);
}

// Yields { done, total } progress; resolves to a de-duplicated track array.
export async function getPlaylistTracks(playlistId, onProgress) {
  const tracks = [];
  const seen = new Set();
  let url = `/playlists/${playlistId}/tracks?limit=100&fields=next,total,items(track(id,name,uri,artists(id,name)))`;
  while (url) {
    const page = await api(url);
    for (const item of page.items) {
      const t = item.track;
      if (!t?.id || seen.has(t.id)) continue; // skip local files, episodes, dupes
      seen.add(t.id);
      tracks.push({
        id: t.id,
        uri: t.uri,
        name: t.name,
        artists: t.artists.map((a) => ({ id: a.id, name: a.name })),
      });
    }
    onProgress?.(tracks.length, page.total);
    url = page.next ? page.next.replace(API_BASE, '') : null;
  }
  return tracks;
}

// Batch-fetch genres for artist IDs. Returns Map<artistId, string[]>.
export async function getArtistGenres(artistIds, onProgress) {
  const genres = new Map();
  const ids = [...new Set(artistIds)].filter(Boolean);
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = await api(`/artists?ids=${batch.join(',')}`);
    for (const artist of data.artists) {
      if (artist) genres.set(artist.id, artist.genres || []);
    }
    onProgress?.(Math.min(i + 50, ids.length), ids.length);
  }
  return genres;
}

export async function getMyPlaylists() {
  const playlists = [];
  let url = '/me/playlists?limit=50';
  while (url) {
    const page = await api(url);
    playlists.push(...page.items.filter(Boolean).map((p) => ({
      id: p.id,
      name: p.name,
      total: p.tracks?.total ?? 0,
      owner: p.owner?.display_name || '',
    })));
    url = page.next ? page.next.replace(API_BASE, '') : null;
  }
  return playlists;
}

export async function createPlaylist(userId, name, description, isPublic) {
  return api(`/users/${userId}/playlists`, {
    method: 'POST',
    body: JSON.stringify({ name, description, public: isPublic }),
  });
}

export async function addTracks(playlistId, uris) {
  for (let i = 0; i < uris.length; i += 100) {
    await api(`/playlists/${playlistId}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
    });
  }
}
