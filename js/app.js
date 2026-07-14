import * as spotify from './spotify.js';
import {
  addVotes, resolveGenre, WEIGHT,
  musicbrainzArtistGenres, lastfmTrackTags, lastfmArtistTags, discogsTrackTags,
} from './genres.js';

// --------------------------------------------------------------- state
const state = {
  user: null,
  playlist: null,      // { id, name }
  tracks: [],          // { id, uri, name, artists, votes: Map, override: string|null }
  abort: null,         // AbortController for a running analysis
};

const $ = (id) => document.getElementById(id);

const els = {
  authStatus: $('auth-status'),
  setupCard: $('setup-card'),
  setupDetails: $('setup-details'),
  clientId: $('client-id'),
  lastfmKey: $('lastfm-key'),
  discogsToken: $('discogs-token'),
  useMusicbrainz: $('use-musicbrainz'),
  connectBtn: $('connect-btn'),
  disconnectBtn: $('disconnect-btn'),
  inputCard: $('input-card'),
  playlistInput: $('playlist-input'),
  loadBtn: $('load-btn'),
  myPlaylistsBtn: $('my-playlists-btn'),
  playlistPicker: $('playlist-picker'),
  progressCard: $('progress-card'),
  playlistName: $('playlist-name'),
  progressBar: $('progress-bar'),
  progressText: $('progress-text'),
  cancelBtn: $('cancel-btn'),
  resultsCard: $('results-card'),
  granularity: $('granularity'),
  minTracks: $('min-tracks'),
  selectAllBtn: $('select-all-btn'),
  selectNoneBtn: $('select-none-btn'),
  genreBuckets: $('genre-buckets'),
  exportCard: $('export-card'),
  namePattern: $('name-pattern'),
  publicPlaylists: $('public-playlists'),
  createBtn: $('create-btn'),
  createCount: $('create-count'),
  createdList: $('created-list'),
  toast: $('toast'),
};

// ----------------------------------------------------------------- ui
let toastTimer;
function toast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle('error', isError);
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 6000);
}

function setProgress(fraction, text) {
  els.progressBar.style.width = `${Math.round(fraction * 100)}%`;
  els.progressText.textContent = text;
}

function showConnected() {
  els.authStatus.textContent = state.user
    ? `Connected as ${state.user.display_name || state.user.id}`
    : '';
  els.connectBtn.classList.toggle('hidden', Boolean(state.user));
  els.disconnectBtn.classList.toggle('hidden', !state.user);
  els.setupDetails.open = !state.user && !spotify.getClientId();
  els.inputCard.classList.toggle('hidden', !state.user);
}

// --------------------------------------------------------------- auth
async function init() {
  els.clientId.value = spotify.getClientId();
  els.lastfmKey.value = localStorage.getItem('ss_lastfm_key') || '';
  els.discogsToken.value = localStorage.getItem('ss_discogs_token') || '';

  try {
    await spotify.handleRedirect();
  } catch (err) {
    toast(err.message, true);
  }
  if (spotify.isConnected()) {
    try {
      state.user = await spotify.me();
    } catch {
      spotify.logout();
    }
  }
  showConnected();
}

els.connectBtn.addEventListener('click', async () => {
  spotify.setClientId(els.clientId.value);
  localStorage.setItem('ss_lastfm_key', els.lastfmKey.value.trim());
  localStorage.setItem('ss_discogs_token', els.discogsToken.value.trim());
  try {
    await spotify.beginLogin();
  } catch (err) {
    els.setupDetails.open = true;
    toast(err.message, true);
  }
});

els.disconnectBtn.addEventListener('click', () => {
  spotify.logout();
  state.user = null;
  showConnected();
  for (const el of [els.progressCard, els.resultsCard, els.exportCard]) {
    el.classList.add('hidden');
  }
});

// ------------------------------------------------------ playlist input
els.myPlaylistsBtn.addEventListener('click', async () => {
  els.myPlaylistsBtn.disabled = true;
  try {
    const playlists = await spotify.getMyPlaylists();
    els.playlistPicker.innerHTML = '';
    for (const p of playlists) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = p.name;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `${p.total} tracks`;
      li.append(name, count);
      li.addEventListener('click', () => {
        els.playlistInput.value = p.id;
        els.playlistPicker.classList.add('hidden');
        analyze(p.id);
      });
      els.playlistPicker.appendChild(li);
    }
    els.playlistPicker.classList.remove('hidden');
  } catch (err) {
    toast(err.message, true);
  } finally {
    els.myPlaylistsBtn.disabled = false;
  }
});

els.loadBtn.addEventListener('click', () => {
  try {
    analyze(spotify.parsePlaylistId(els.playlistInput.value));
  } catch (err) {
    toast(err.message, true);
  }
});

els.cancelBtn.addEventListener('click', () => state.abort?.abort());

// ------------------------------------------------------------ analysis
async function analyze(playlistId) {
  state.abort?.abort();
  const abort = new AbortController();
  state.abort = abort;
  const lastfmKey = els.lastfmKey.value.trim();
  const discogsToken = els.discogsToken.value.trim();
  const useMb = els.useMusicbrainz.checked;

  els.resultsCard.classList.add('hidden');
  els.exportCard.classList.add('hidden');
  els.progressCard.classList.remove('hidden');
  setProgress(0, 'Loading playlist…');

  try {
    const meta = await spotify.getPlaylistMeta(playlistId);
    state.playlist = { id: meta.id, name: meta.name };
    els.playlistName.textContent = `“${meta.name}”`;

    // 1. All tracks (10% of the bar)
    const tracks = await spotify.getPlaylistTracks(playlistId, (done, total) =>
      setProgress(0.1 * (done / total), `Fetching tracks… ${done}/${total}`));
    if (abort.signal.aborted) return;
    if (tracks.length === 0) throw new Error('This playlist has no usable tracks.');
    state.tracks = tracks.map((t) => ({ ...t, votes: new Map(), override: null }));

    // 2. Spotify artist genres (10-20%)
    const artistIds = tracks.flatMap((t) => t.artists.map((a) => a.id));
    const spotifyGenres = await spotify.getArtistGenres(artistIds, (done, total) =>
      setProgress(0.1 + 0.1 * (done / total), `Spotify artist genres… ${done}/${total} artists`));
    if (abort.signal.aborted) return;
    for (const track of state.tracks) {
      for (const artist of track.artists) {
        addVotes(track.votes, spotifyGenres.get(artist.id) || [], WEIGHT.spotifyArtist);
      }
    }

    // 3. Last.fm per-track + per-artist tags (20-45%), concurrent-friendly
    if (lastfmKey) {
      const artistNames = [...new Set(tracks.map((t) => t.artists[0]?.name).filter(Boolean))];
      const artistTagCache = new Map();
      let done = 0;
      const jobs = state.tracks.map((track) => async () => {
        if (abort.signal.aborted) return;
        const artist = track.artists[0]?.name;
        if (!artist) return;
        const trackTags = await lastfmTrackTags(lastfmKey, artist, track.name);
        addVotes(track.votes, trackTags, WEIGHT.lastfmTrack);
        if (!artistTagCache.has(artist)) {
          artistTagCache.set(artist, lastfmArtistTags(lastfmKey, artist));
        }
        addVotes(track.votes, await artistTagCache.get(artist), WEIGHT.lastfmArtist);
        done += 1;
        setProgress(0.2 + 0.25 * (done / state.tracks.length),
          `Last.fm tags… ${done}/${state.tracks.length} tracks (${artistNames.length} artists)`);
      });
      // Limit concurrency to stay friendly to the API.
      await runPool(jobs, 4);
      if (abort.signal.aborted) return;
    }

    // 4. Discogs per-track styles/genres (45-70%) — throttled to their
    //    60 req/min limit, cached, so re-runs skip straight through
    if (discogsToken) {
      for (let i = 0; i < state.tracks.length; i += 1) {
        if (abort.signal.aborted) return;
        const track = state.tracks[i];
        const artist = track.artists[0]?.name;
        if (!artist) continue;
        setProgress(0.45 + 0.25 * (i / state.tracks.length),
          `Discogs… ${i + 1}/${state.tracks.length} tracks (throttled to 1/sec — cached for next time)`);
        const { styles, genres } = await discogsTrackTags(discogsToken, artist, track.name, abort.signal);
        addVotes(track.votes, styles, WEIGHT.discogsStyle);
        addVotes(track.votes, genres, WEIGHT.discogsGenre);
      }
    }

    // 5. MusicBrainz artist genres (70-100%) — 1 req/sec per their rules
    if (useMb) {
      const uniqueArtists = [...new Set(tracks.map((t) => t.artists[0]?.name).filter(Boolean))];
      const mbGenres = new Map();
      for (let i = 0; i < uniqueArtists.length; i += 1) {
        if (abort.signal.aborted) return;
        const name = uniqueArtists[i];
        setProgress(0.7 + 0.3 * (i / uniqueArtists.length),
          `MusicBrainz… ${i + 1}/${uniqueArtists.length} artists (throttled to 1/sec — cached for next time)`);
        mbGenres.set(name, await musicbrainzArtistGenres(name, abort.signal));
      }
      for (const track of state.tracks) {
        const name = track.artists[0]?.name;
        addVotes(track.votes, mbGenres.get(name) || [], WEIGHT.musicbrainzArtist);
      }
    }

    setProgress(1, 'Done!');
    els.progressCard.classList.add('hidden');
    renderResults();
  } catch (err) {
    if (err.name === 'AbortError') {
      els.progressCard.classList.add('hidden');
      return;
    }
    setProgress(0, '');
    els.progressCard.classList.add('hidden');
    toast(err.message, true);
  }
}

// Run async thunks with limited concurrency.
async function runPool(thunks, size) {
  const queue = [...thunks];
  const workers = Array.from({ length: size }, async () => {
    while (queue.length) await queue.shift()();
  });
  await Promise.all(workers);
}

// ------------------------------------------------------------- results
function bucketTracks() {
  const granularity = els.granularity.value;
  const buckets = new Map(); // genre -> tracks[]
  for (const track of state.tracks) {
    const genre = track.override || resolveGenre(track.votes, granularity);
    if (!buckets.has(genre)) buckets.set(genre, []);
    buckets.get(genre).push(track);
  }
  return [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
}

function renderResults() {
  const minTracks = Math.max(1, Number(els.minTracks.value) || 1);
  const buckets = bucketTracks();
  const genreNames = buckets.map(([g]) => g);
  els.genreBuckets.innerHTML = '';

  for (const [genre, tracks] of buckets) {
    const details = document.createElement('details');
    details.className = 'bucket';

    const summary = document.createElement('summary');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.genre = genre;
    checkbox.checked = tracks.length >= minTracks && genre !== 'Unknown' && genre !== 'Other';
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', updateCreateCount);

    const name = document.createElement('span');
    name.className = 'genre-name';
    name.textContent = genre;
    const count = document.createElement('span');
    count.className = 'track-count';
    count.textContent = `${tracks.length} track${tracks.length === 1 ? '' : 's'}`;
    summary.append(checkbox, name, count);
    details.appendChild(summary);

    const list = document.createElement('ul');
    list.className = 'track-list';
    for (const track of tracks) {
      const li = document.createElement('li');
      const title = document.createElement('span');
      title.className = 'track-title';
      title.textContent = track.name;
      const artist = document.createElement('span');
      artist.className = 'track-artist';
      artist.textContent = track.artists.map((a) => a.name).join(', ');

      const select = document.createElement('select');
      select.title = 'Move this track to a different genre';
      for (const g of genreNames) {
        const opt = document.createElement('option');
        opt.value = g;
        opt.textContent = g;
        opt.selected = g === genre;
        select.appendChild(opt);
      }
      select.addEventListener('change', () => {
        track.override = select.value;
        renderResults();
      });

      li.append(title, artist, select);
      list.appendChild(li);
    }
    details.appendChild(list);
    els.genreBuckets.appendChild(details);
  }

  els.resultsCard.classList.remove('hidden');
  els.exportCard.classList.remove('hidden');
  updateCreateCount();
}

function selectedGenres() {
  return [...els.genreBuckets.querySelectorAll('input[type="checkbox"]:checked')]
    .map((cb) => cb.dataset.genre);
}

function updateCreateCount() {
  const n = selectedGenres().length;
  els.createCount.textContent = String(n);
  els.createBtn.disabled = n === 0;
}

els.granularity.addEventListener('change', () => {
  // Overrides refer to genre names from the other granularity; reset them.
  for (const track of state.tracks) track.override = null;
  renderResults();
});
els.minTracks.addEventListener('change', renderResults);
els.selectAllBtn.addEventListener('click', () => {
  els.genreBuckets.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = true; });
  updateCreateCount();
});
els.selectNoneBtn.addEventListener('click', () => {
  els.genreBuckets.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
  updateCreateCount();
});

// -------------------------------------------------------------- export
els.createBtn.addEventListener('click', async () => {
  const chosen = new Set(selectedGenres());
  const buckets = bucketTracks().filter(([genre]) => chosen.has(genre));
  if (buckets.length === 0) return;

  els.createBtn.disabled = true;
  els.createdList.innerHTML = '';
  const pattern = els.namePattern.value || '{source} — {genre}';
  const isPublic = els.publicPlaylists.checked;

  try {
    for (const [genre, tracks] of buckets) {
      const name = pattern
        .replaceAll('{genre}', genre)
        .replaceAll('{source}', state.playlist.name);
      const description = `${genre} tracks from “${state.playlist.name}”, sorted by SongSorter`;
      const playlist = await spotify.createPlaylist(state.user.id, name, description, isPublic);
      await spotify.addTracks(playlist.id, tracks.map((t) => t.uri));

      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = playlist.external_urls?.spotify || '#';
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = `✅ ${name} (${tracks.length} tracks)`;
      li.appendChild(a);
      els.createdList.appendChild(li);
    }
    toast(`Created ${buckets.length} playlist${buckets.length === 1 ? '' : 's'} 🎉`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    els.createBtn.disabled = false;
    updateCreateCount();
  }
});

init();
