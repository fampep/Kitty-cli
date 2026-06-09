KittyCLI
========

Anime aggregator terminal client – search, stream, and download from multiple
providers via a unified API.

Features
--------

- Multi‑provider search (auto‑merged results)
- Stream episodes with mpv
- Download single or batch episodes (resumable HTTP, HLS fallback)
- Watchlist with progress tracking
- Persistent search history
- Binge mode with countdown and audio toggle
- Metadata panel (synopsis, rating, genres)
- Custom mpv arguments and playback speed
- Clipboard copy of stream URLs
- Subtitle download when available
- Settings for default action, audio, page size, API endpoint

Installation
------------

Prerequisites:
- Node.js (v18 or later)
- mpv (for playback)
- ffmpeg (only for HLS downloads, optional)

From npm:
  npm install -g kittycli

From source:
  git clone https://github.com/fampep/Kitty-cli.git
  cd Kitty-cli
  npm install
  npm install -g .

Usage
-----

Run the interactive menu:
  kittycli

Search directly:
  kittycli --search "One Piece"

Keyboard Navigation
-------------------
  ↑ / ↓         Move through menus
  Enter         Select
  1‑9           Quick pick visible row
  Home / End    Jump to top/bottom
  PageUp/Down   Change page
  Q / Esc       Go back
  ?             Help
  Ctrl+C        Exit

Default API Endpoint
--------------------
The CLI uses https://fampepanikotoapi.buzz by default.
You can change the API URL in Settings → API Base URL.

Configuration
-------------
Settings are stored in ~/.kittycli/settings.json.
You can also modify them from the interactive menu.

Available settings:
  Default action    Ask, stream, or download
  Binge countdown   Seconds before next episode auto‑plays (3‑120)
  Default audio     SUB or DUB
  Playback speed    0.5 – 3.0
  mpv arguments     Extra flags passed to mpv
  Menu page size    Rows per page (6‑20)
  API Base URL      Backend endpoint
  Auto‑update check Enable/disable version notification

Data Directory
--------------
All local data is stored in ~/.kittycli/:
  watchlist.json      saved anime progress
  search-history.json recent queries
  settings.json       user preferences
  cache.json          search results cache

License
-------
GNU General Public License v3.0 – see the LICENSE file for details.
