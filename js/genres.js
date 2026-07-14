// Genre resolution: merge tags from Spotify artist metadata, MusicBrainz,
// Discogs, and (optionally) Last.fm into one weighted vote per track, then
// resolve each track to a genre at the chosen granularity.
//
// RateYourMusic has no public API and its terms forbid scraping (the old
// beets-rymgenre scraper got its own author banned in 2016 and is
// abandoned), so RYM is deliberately not queried. Discogs styles,
// MusicBrainz genres, and Last.fm community tags cover the same ground
// with open access; the planned Sonemic API would slot in here as
// another vote source.

// ---------------------------------------------------------------- weights
const WEIGHT = {
  lastfmTrack: 3,    // per-track community tags are the strongest signal
  discogsStyle: 2.5, // per-release "styles" are granular, RYM-like genres
  spotifyArtist: 2,
  musicbrainzArtist: 2,
  lastfmArtist: 1,
  discogsGenre: 1,   // Discogs top-level genres are very broad
};

// ------------------------------------------------- tag cleanup / mapping
// Community tags that are not genres.
const TAG_DENYLIST = new Set([
  'seen live', 'favorites', 'favourite', 'favourites', 'favorite songs',
  'awesome', 'love', 'loved', 'beautiful', 'epic', 'chill', 'good',
  'male vocalists', 'female vocalists', 'male vocalist', 'female vocalist',
  'american', 'british', 'uk', 'usa', 'german', 'french', 'swedish',
  'japanese', 'canadian', 'australian', 'english', 'spotify',
  'under 2000 listeners', 'all', 'albums i own', 'check out',
  '00s', '10s', '60s', '70s', '80s', '90s', '2000s', '2010s', '2020s',
  'oldies', 'classic', 'summer', 'winter', 'party', 'sad', 'happy',
  'instrumental', 'live', 'cover', 'covers', 'remix', 'soundtrack',
  'christmas', 'workout', 'study', 'sleep', 'driving',
]);

// keyword → broad family. When several keywords match one tag, the match
// ending furthest right wins (longer keyword breaks ties), because hybrid
// genre names put the base genre last: "folk rock" → Rock, "jazz rap" →
// Hip Hop, while "k-pop" still beats plain "pop" by length.
const BROAD_RULES = [
  ['hip hop|hip-hop|rap|trap|drill|grime|boom bap|crunk|hyphy', 'Hip Hop'],
  ['metal|metalcore|deathcore|grindcore|djent|sludge|doom', 'Metal'],
  ['punk|hardcore|emo|screamo|oi!', 'Punk'],
  ['house|techno|trance|dubstep|drum and bass|drum & bass|dnb|jungle|edm|electro|garage|breakbeat|idm|ambient|synthwave|vaporwave|downtempo|trip hop|trip-hop|bass music|footwork|hardstyle|eurodance|big beat', 'Electronic'],
  ['jazz|bebop|bossa nova|swing', 'Jazz'],
  ['classical|baroque|romantic era|orchestral|opera|symphony|chamber music|choral', 'Classical'],
  ['country|bluegrass|americana|honky tonk', 'Country'],
  ['folk|singer-songwriter|acoustic', 'Folk'],
  ['blues', 'Blues'],
  ['reggae|ska|dub|dancehall|reggaeton', 'Reggae'],
  ['soul|funk|r&b|rnb|rhythm and blues|motown|disco|neo mellow|new jack swing', 'R&B / Soul'],
  ['gospel|christian|worship', 'Gospel'],
  ['latin|salsa|cumbia|bachata|merengue|mariachi|banda|corrido|bolero|flamenco|tango', 'Latin'],
  ['k-pop|kpop|j-pop|jpop|city pop|c-pop|mandopop', 'Asian Pop'],
  ['afrobeat|afrobeats|highlife|amapiano|world|celtic|klezmer|bhangra|bollywood', 'World'],
  ['rock|grunge|shoegaze|britpop|post-rock|new wave|psychedelic|garage|indie|alternative|lo-fi|lofi', 'Rock'],
  ['pop|dance pop|synthpop|electropop|europop', 'Pop'],
];

const BROAD_REGEXES = BROAD_RULES.map(([kw, family]) => [
  new RegExp(`(^|[ /-])(${kw})([ /-]|$)`, 'i'),
  family,
]);

export function normalizeTag(raw) {
  const tag = raw.toLowerCase().trim()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ');
  if (!tag || tag.length > 40 || TAG_DENYLIST.has(tag)) return null;
  return tag;
}

export function broadFamily(tag) {
  let best = null;
  let bestEnd = -1;
  let bestLen = -1;
  for (const [re, family] of BROAD_REGEXES) {
    const m = re.exec(tag);
    if (!m) continue;
    const keyword = m[2];
    const end = m.index + m[1].length + keyword.length;
    if (end > bestEnd || (end === bestEnd && keyword.length > bestLen)) {
      best = family;
      bestEnd = end;
      bestLen = keyword.length;
    }
  }
  return best;
}

function titleCase(tag) {
  return tag.replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bAnd\b/g, 'and').replace(/\bOf\b/g, 'of')
    .replace(/\bR&b\b/g, 'R&B').replace(/\bEdm\b/g, 'EDM')
    .replace(/\bIdm\b/g, 'IDM').replace(/\bUk\b/g, 'UK');
}

// ------------------------------------------------------------ throttling
function createThrottle(minIntervalMs) {
  let last = 0;
  return async function throttled() {
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
  };
}

// --------------------------------------------------------- MusicBrainz
// Per their API etiquette: max 1 request/second, identify the app.
const MB_BASE = 'https://musicbrainz.org/ws/2';
const mbThrottle = createThrottle(1100);
const MB_CACHE_KEY = 'ss_mb_cache_v1';

function loadCache(storageKey) {
  try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); }
  catch { return {}; }
}
function saveCache(storageKey, cache) {
  try { localStorage.setItem(storageKey, JSON.stringify(cache)); }
  catch { /* quota exceeded — cache is best-effort */ }
}

async function mbFetch(path) {
  await mbThrottle();
  const res = await fetch(`${MB_BASE}${path}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`MusicBrainz error ${res.status}`);
  return res.json();
}

// Returns string[] of genre tags for an artist name (cached in localStorage).
export async function musicbrainzArtistGenres(artistName, signal) {
  const cache = loadCache(MB_CACHE_KEY);
  const key = artistName.toLowerCase();
  if (key in cache) return cache[key];
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

  let genres = [];
  try {
    const search = await mbFetch(
      `/artist?query=artist:${encodeURIComponent(JSON.stringify(artistName))}&limit=1&fmt=json`,
    );
    const artist = search.artists?.[0];
    // Only trust confident name matches.
    if (artist && artist.score >= 85) {
      const detail = await mbFetch(`/artist/${artist.id}?inc=genres+tags&fmt=json`);
      const fromGenres = (detail.genres || []).map((g) => g.name);
      const fromTags = (detail.tags || [])
        .filter((t) => t.count >= 2)
        .map((t) => t.name);
      genres = [...new Set([...fromGenres, ...fromTags])];
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // Network/API hiccup: return empty but don't cache, so it retries next run.
    return [];
  }
  cache[key] = genres;
  saveCache(MB_CACHE_KEY, cache);
  return genres;
}

// --------------------------------------------------------------- Discogs
// Free API, personal token from discogs.com/settings/developers.
// Rate limit is 60 requests/minute authenticated, so throttle to ~1/sec.
// Release "styles" are the granular, RYM-like part of the taxonomy;
// top-level "genres" (Rock, Electronic, …) are only a weak extra vote.
const DISCOGS_BASE = 'https://api.discogs.com';
const discogsThrottle = createThrottle(1100);
const DISCOGS_CACHE_KEY = 'ss_discogs_cache_v1';
const EMPTY_DISCOGS = { styles: [], genres: [] };

// Returns { styles: string[], genres: string[] } for a track,
// merged from the top search matches (cached in localStorage).
export async function discogsTrackTags(token, artistName, trackName, signal) {
  const cache = loadCache(DISCOGS_CACHE_KEY);
  const key = `${artistName}|${trackName}`.toLowerCase();
  if (key in cache) return cache[key];
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

  let result;
  try {
    await discogsThrottle();
    const qs = new URLSearchParams({
      artist: artistName,
      track: trackName,
      type: 'release',
      per_page: '3',
      token,
    });
    let res = await fetch(`${DISCOGS_BASE}/database/search?${qs}`);
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 5000));
      res = await fetch(`${DISCOGS_BASE}/database/search?${qs}`);
    }
    if (res.status === 401) throw new Error('Discogs rejected the token — check it in settings.');
    if (!res.ok) throw new Error(`Discogs error ${res.status}`);
    const data = await res.json();
    const styles = new Set();
    const genres = new Set();
    for (const release of (data.results || []).slice(0, 3)) {
      for (const s of release.style || []) styles.add(s);
      for (const g of release.genre || []) genres.add(g);
    }
    result = { styles: [...styles], genres: [...genres] };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    if (err.message.includes('token')) throw err; // bad token: fail loudly
    // Network/API hiccup: return empty but don't cache, so it retries next run.
    return EMPTY_DISCOGS;
  }
  cache[key] = result;
  saveCache(DISCOGS_CACHE_KEY, cache);
  return result;
}

// -------------------------------------------------------------- Last.fm
const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/';

async function lastfmCall(apiKey, params) {
  const qs = new URLSearchParams({ ...params, api_key: apiKey, format: 'json' });
  const res = await fetch(`${LASTFM_BASE}?${qs}`);
  if (!res.ok) throw new Error(`Last.fm error ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Last.fm: ${data.message}`);
  return data;
}

// Returns [{ tag, weight }] — weight is Last.fm's 0-100 relative count.
export async function lastfmTrackTags(apiKey, artistName, trackName) {
  try {
    const data = await lastfmCall(apiKey, {
      method: 'track.getTopTags',
      artist: artistName,
      track: trackName,
      autocorrect: '1',
    });
    return (data.toptags?.tag || [])
      .filter((t) => Number(t.count) >= 10)
      .slice(0, 8)
      .map((t) => ({ tag: t.name, weight: Number(t.count) / 100 }));
  } catch {
    return [];
  }
}

export async function lastfmArtistTags(apiKey, artistName) {
  try {
    const data = await lastfmCall(apiKey, {
      method: 'artist.getTopTags',
      artist: artistName,
      autocorrect: '1',
    });
    return (data.toptags?.tag || [])
      .filter((t) => Number(t.count) >= 20)
      .slice(0, 6)
      .map((t) => ({ tag: t.name, weight: Number(t.count) / 100 }));
  } catch {
    return [];
  }
}

// ------------------------------------------------------------- resolver
// votes: Map<normalizedTag, score> accumulated per track.
export function addVotes(votes, tags, weight) {
  for (const entry of tags) {
    const raw = typeof entry === 'string' ? entry : entry.tag;
    const factor = typeof entry === 'string' ? 1 : entry.weight;
    const tag = normalizeTag(raw);
    if (!tag) continue;
    votes.set(tag, (votes.get(tag) || 0) + weight * factor);
  }
}

export { WEIGHT };

// Given a track's vote map, return its genre at the requested granularity.
export function resolveGenre(votes, granularity) {
  if (votes.size === 0) return 'Unknown';
  if (granularity === 'broad') {
    const familyScores = new Map();
    for (const [tag, score] of votes) {
      const family = broadFamily(tag);
      if (family) familyScores.set(family, (familyScores.get(family) || 0) + score);
    }
    if (familyScores.size === 0) return 'Other';
    return topEntry(familyScores);
  }
  // Detailed: prefer the highest-scoring tag that maps to a known family
  // (i.e. looks like a real genre), falling back to the top tag overall.
  let best = null;
  let bestScore = -1;
  for (const [tag, score] of votes) {
    const isGenreLike = broadFamily(tag) !== null;
    const adjusted = isGenreLike ? score * 1.5 : score;
    if (adjusted > bestScore) { bestScore = adjusted; best = tag; }
  }
  return titleCase(best);
}

function topEntry(map) {
  let best = null;
  let bestScore = -1;
  for (const [k, v] of map) {
    if (v > bestScore) { bestScore = v; best = k; }
  }
  return best;
}
