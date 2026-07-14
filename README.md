# 🎛️ SongSorter

A single-page web app that takes a Spotify playlist, cross-references every
track against community genre databases, lets you review and adjust the
result, and writes one playlist per genre back into your Spotify account.

**No server, no build step.** Everything runs in your browser using Spotify's
Authorization Code + PKCE flow, so it can be hosted on GitHub Pages or any
static host — or run straight off your machine.

## How genres are determined

Each track collects weighted "votes" from several sources, which are then
normalized and merged:

| Source | What it provides | Weight |
|---|---|---|
| Last.fm `track.getTopTags` (optional) | Per-**track** community tags — the most precise signal | 3× |
| Spotify artist metadata | Spotify's own genre labels per artist | 2× |
| MusicBrainz | Open-database genres + community tags per artist | 2× |
| Last.fm `artist.getTopTags` (optional) | Per-artist community tags | 1× |

Non-genre tags ("seen live", "favorites", decades, moods, nationalities) are
filtered out. You choose the granularity:

- **Broad** — Rock, Electronic, Hip Hop, Jazz, Metal, R&B / Soul, …
- **Detailed** — the strongest specific tag per track (Shoegaze, Jungle,
  Neo-Soul, Boom Bap, …)

Every track can be manually moved to a different genre before export, and you
pick exactly which genre buckets become playlists.

### Why not RateYourMusic?

RYM's genre taxonomy is excellent, but it has **no public API** and its terms
of service prohibit scraping. MusicBrainz (fully open database) and Last.fm
(free API) provide comparable community-sourced genre data, so SongSorter
uses those instead. If RYM/Sonemic ever ships a public API, it would slot
into `js/genres.js` as another vote source.

## Setup

### 1. Create a Spotify app (free, 2 minutes)

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
   and click **Create app**.
2. Add the exact URL where SongSorter will run as a **Redirect URI**:
   - GitHub Pages: `https://<you>.github.io/songsorter/`
   - Local dev: `http://127.0.0.1:8000/` (Spotify requires HTTPS or the
     `127.0.0.1` loopback address — plain `http://localhost` is rejected)
3. Select **Web API**, save, and copy the **Client ID**.

### 2. (Optional) Get a Last.fm API key

Per-track tags noticeably improve accuracy for playlists that mix genres
within one artist. Create a key at
[last.fm/api/account/create](https://www.last.fm/api/account/create) —
instant and free.

### 3. Run it

**Locally:**

```sh
cd songsorter
python3 -m http.server 8000 --bind 127.0.0.1
# open http://127.0.0.1:8000/
```

**GitHub Pages:** push this directory to a repo, enable Pages, and make sure
the Redirect URI in your Spotify app matches the published URL exactly
(including the trailing slash).

Then open the page, paste your Client ID (stored only in your browser's
localStorage), connect, and sort.

## Usage

1. **Connect Spotify** — one-time OAuth consent for reading playlists and
   creating playlists.
2. **Choose a playlist** — paste any playlist link/URI/ID, or pick from your
   own playlists.
3. **Wait for analysis** — Spotify lookups are fast; MusicBrainz is throttled
   to 1 request/second per their API etiquette (results are cached in
   localStorage, so re-runs are much faster). You can disable MusicBrainz in
   the settings for a quick pass.
4. **Review** — switch granularity, tick the genre buckets you want, move
   individual tracks between genres.
5. **Create playlists** — choose a naming pattern (default:
   `My Playlist — Shoegaze`) and whether they're public. Links to the new
   playlists appear when done.

## Project layout

```
index.html      UI skeleton
css/styles.css  styling
js/spotify.js   PKCE auth + Spotify Web API client
js/genres.js    MusicBrainz / Last.fm lookups, tag normalization, vote merging
js/app.js       orchestration and UI logic
```

## Privacy

- Tokens and API keys are stored in your browser's localStorage only.
- No analytics, no backend, no third parties beyond the APIs listed above.
- The Spotify token can be revoked anytime at
  [spotify.com/account/apps](https://www.spotify.com/account/apps/).
