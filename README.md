kittycli

Anime aggregator terminal client with multi-provider search, streaming, downloads, and watchlist.

Installation
  npm install -g @fampep/kittycli

Usage
  kittycli

Requirements
  Node.js 18+
  mpv (for streaming)
  ffmpeg (optional, for HLS downloads)

Features
  - Multi-provider parallel search
  - Stream episodes via mpv
  - Resumable HTTP/HLS downloads
  - Batch download episodes
  - Watchlist with progress tracking
  - Binge mode with countdown
  - Subtitle download
  - Anime metadata from AniList

Data directory
  ~/.kittycli/
    watchlist.json
    search-history.json
    settings.json
    cache.json

License
  GPL-3.0