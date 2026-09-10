# SongSorter — handoff

Static single-page web app that reads a Spotify playlist, cross-references
each track's genre against several open music databases, and writes one
playlist per genre back into the user's Spotify account. No server, no
build step — plain HTML/CSS/JS, deployed on GitHub Pages.

**Live site:** https://s66lem.github.io/songsorter/
**Repo:** https://github.com/s66lem/songsorter (public, `main` branch, deploys
automatically on every push via `.github/workflows/pages.yml`)

## Status: blocked on one bug

Everything is built and deployed. The one open item is a **403 Forbidden**
from Spotify when fetching a playlist's tracks — see "Open bug" below before
doing anything else with this repo.

## Architecture

```
index.html      UI skeleton (5-step flow: connect → pick playlist →
                progress → review genres → export)
css/styles.css  styling, dark theme
js/spotify.js   Spotify auth (Authorization Code + PKCE, entirely
                client-side) and Web API calls
js/genres.js    genre lookups (MusicBrainz, Discogs, Last.fm), tag
                normalization/denylist, weighted vote merging
js/app.js       orchestration: wires the UI to spotify.js + genres.js,
                runs the analysis pipeline, renders results, handles export
```

No dependencies, no bundler. Everything runs in the browser; API keys/tokens
live in `localStorage` only.

### Genre resolution

Each track collects weighted votes from up to four sources, normalized and
merged (see `js/genres.js` for the exact weights and the broad-genre keyword
map):

| Source | Granularity | Weight | Required? |
|---|---|---|---|
| Last.fm `track.getTopTags` | per-track | 3× | optional (API key) |
| Discogs release styles | per-release | 2.5× | optional (personal token) |
| Spotify artist genres | per-artist | 2× | always on |
| MusicBrainz artist genres | per-artist | 2× | on by default, togglable |
| Last.fm `artist.getTopTags` | per-artist | 1× | optional |
| Discogs top-level genres | per-release | 1× | optional |

Junk tags (moods, decades, "seen live", nationalities, etc.) are filtered by
a denylist. User picks "broad" (Rock, Electronic, Hip Hop…) or "detailed"
(Shoegaze, Jungle, Neo-Soul…) granularity in the UI; tracks can be manually
overridden before export.

**RateYourMusic is intentionally not used as a source.** It has no public
API and its ToS forbid scraping — the old `beets-rymgenre` scraper's author
was banned from RYM in 2016 for this and now recommends against using it.
Discogs styles are the closest legitimate substitute (see README's "Why not
RateYourMusic?" section for the full rationale and a link to RYM's Sonemic
API waitlist, which is the real long-term fix if/when it ships).

## Open bug: 403 on `GET /playlists/{id}/tracks`

**Symptom:** `spotify.js:110` (the generic `api()` fetch wrapper) throws a
403 when `getPlaylistTracks()` calls
`GET /v1/playlists/{id}/tracks?limit=100&fields=...`.

**Confirmed so far:**
- Playlist is `https://open.spotify.com/playlist/41EEhwMS5lsasS5kvDcCcE`,
  owned by the user testing it (not a Spotify-curated/algorithmic playlist —
  that was the first hypothesis, ruled out).
- The preceding call, `GET /playlists/{id}` (playlist metadata — name,
  owner, track count) in `getPlaylistMeta()`, **succeeds**. Only the
  `/tracks` sub-resource 403s. This rules out a totally dead/invalid token
  (that would 401, and would fail the metadata call too).
- Not reproducible from this side: `open.spotify.com` and `api.spotify.com`
  are both unreachable from this sandbox's network egress proxy, and there's
  no browser/Chrome-extension tool available in this environment to drive
  the user's own browser. Diagnosis has to happen either in the user's
  browser DevTools or via Spotify's own tools.

**Not yet known:** the actual `error.message` string Spotify returns in the
403 response body. This is the single most useful missing fact — it
distinguishes between:
- insufficient OAuth scope (stale consent — try Disconnect/Connect again)
- app stuck in Development Mode with the test account not on the
  allow-list (Spotify Dashboard → app → Settings → User Management)
- something specific to this playlist (collaborative-playlist scope
  quirk, regional/licensing restriction, etc.)

**Last instruction given to the user:** open
[Spotify's "Get Playlist Items" API reference](https://developer.spotify.com/documentation/web-api/reference/get-playlist-items),
use the "Try it" panel's **Get Token** button (granting
`playlist-read-private` + `playlist-read-collaborative`), plug in playlist ID
`41EEhwMS5lsasS5kvDcCcE`, and send the request. Whatever JSON comes back
(especially `error.message`) should make the root cause obvious.

**Next steps once that message is known:**
- If it's a scope issue → likely just needs Disconnect/Connect in the app
  itself; if it persists, check `SCOPES` in `js/spotify.js` matches what
  Spotify's console needed.
- If it's Development Mode / allow-list → user needs to add their own
  Spotify account under the app's User Management in the dashboard (this is
  a dashboard setting, not a code fix).
- If it's something else entirely → will need to read the message and
  reassess; don't guess further without it.

## Deployment notes (for future reference — these took a few tries)

- GitHub Pages **cannot** deploy from a private repo on a free plan — the
  repo had to be switched to public first (Settings → Danger Zone → Change
  visibility; note this requires typing the repo name to confirm, easy to
  miss the second dialog).
- The `actions/configure-pages@v5` step's `enablement: true` option, which
  is supposed to auto-create the Pages site from the workflow, **does not
  have permission to do so** in this repo (`Resource not accessible by
  integration`) even with `pages: write` in the workflow's permissions
  block. Pages had to be enabled manually once: repo Settings → Pages →
  set Source to "GitHub Actions". After that one-time manual step, the
  existing workflow deploys fine on every push.
- Workflow file: `.github/workflows/pages.yml` — triggers on push to `main`
  and via manual `workflow_dispatch`.

## Setup required before the app is usable end-to-end

Documented in full in `README.md`, summarized here:

1. A Spotify app (free) at the
   [Developer Dashboard](https://developer.spotify.com/dashboard), with
   `https://s66lem.github.io/songsorter/` registered as a Redirect URI.
   Client ID gets pasted into the page's settings panel.
2. Optional: a free Last.fm API key, and/or a free Discogs personal token,
   pasted into the same settings panel, for the higher-weighted per-track
   genre sources. The app works without either, just less precisely.
3. MusicBrainz needs no key but is throttled to 1 request/second per their
   API etiquette, with results cached in `localStorage`.

## What's verified working vs. not yet confirmed

**Verified:**
- All JS passes `node --check` syntax validation.
- Page loads in headless Chromium with zero console errors; OAuth redirect
  to `accounts.spotify.com` fires correctly.
- Genre resolution logic (`js/genres.js`) unit-tested standalone with a
  mocked `fetch` — tag normalization, denylist filtering, broad-family
  keyword matching (including hybrid genre names like "folk rock" → Rock,
  "jazz rap" → Hip Hop), vote weighting, and Discogs caching/401-handling
  all pass.
- GitHub Pages deployment is live and auto-redeploys on push.

**Not yet confirmed (blocked by the open bug above):**
- A full end-to-end run — connect, load playlist, analyze, review, export —
  has not completed successfully against a real playlist. The 403 above is
  the first real-world test hitting a wall.
