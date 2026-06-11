kittycli

Anime aggregator terminal client with multi-provider search, streaming, downloads, and watchlist.

[npm version] https://img.shields.io/npm/v/@fampep/kittycli.svg
[License] https://img.shields.io/badge/license-GPL--3.0-blue.svg
[Node.js Version] https://img.shields.io/badge/node-%3E%3D18.0-brightgreen

Install

npm install -g @fampep/kittycli

Usage

kittycli

Run without arguments to start the interactive terminal interface.

Features

Search: Parallel search across multiple providers with fuzzy ranking
Streaming: Play episodes instantly via mpv with subtitle support
Downloads: Resumable HTTP/HLS downloads, single or batch
Watchlist: Track episode progress, resume where you left off
Binge Mode: Auto-play next episode with configurable countdown
Metadata: Anime details (synopsis, rating, genres) from AniList
Settings: Customize API URL, playback speed, mpv args, page size

Requirements

Node.js 18 or higher
mpv – required for streaming
ffmpeg – optional, improves HLS download support

Configuration

All data is stored in ~/.kittycli/:

watchlist.json – your watch history
search-history.json – recent searches
settings.json – user preferences
cache.json – temporary cache

License

GPL-3.0