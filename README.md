# KittyCLI

Terminal-based anime streaming and management client with multi-provider search, streaming, downloads, and watchlist tracking.

## Installation

```bash
npm install -g @fampep/kittycli
```

Then run:
```bash
kittycli
```

## Requirements

- **Node.js** 18+
- **mpv** - for streaming
  - Windows: `choco install mpv` or `winget install mpv.net`
  - macOS: `brew install mpv`
  - Linux: `apt install mpv`

- **ffmpeg** (optional) - for HLS downloads
  - Windows: `choco install ffmpeg` or `winget install ffmpeg`
  - macOS: `brew install ffmpeg`
  - Linux: `apt install ffmpeg`

## Features

- **Multi-Provider Search** - Search 15+ anime providers simultaneously
- **Streaming** - Watch with quality selection and automatic subtitles
- **Downloads** - MKV/MP4 with resumable progress and batch processing
- **Watchlist** - Track progress and resume positions automatically
- **Binge Mode** - Auto-play next episode with countdown
- **AniList Integration** - Episode titles, metadata, and airing schedules
- **Discord Rich Presence** - Show what you're watching to friends
- **Subtitle Management** - Auto-download and organize by series

## Quick Start

1. Launch the app: `kittycli`
2. Select "Search anime" from the menu
3. Find your series and select a provider
4. Choose your episode and press Enter to stream
5. Progress saves automatically

## Keyboard Controls

| Key | Action |
|-----|--------|
| UP/DOWN | Navigate menu |
| ENTER | Select item |
| 1-9 | Quick jump |
| HOME/END | Top/bottom |
| PAGE UP/DOWN | Next page |
| Q/ESC | Go back |
| ? | Help |
| CTRL+C | Exit |

### Binge Mode

| Key | Action |
|-----|--------|
| Y/ENTER | Play next episode |
| N | Stop |
| A | Toggle SUB/DUB |

## Configuration

Settings stored at: `~/.kittycli/settings.json`

Key options:
- `defaultAudio` - sub or dub
- `downloadFormat` - mkv or mp4
- `playbackSpeed` - 0.5x to 3.0x
- `bingeCountdownSeconds` - delay between episodes
- `resumePlayback` - auto-resume from last position
- `discordEnabled` - show Discord presence
- `preferredQuality` - auto, 1080p, 720p, etc
- `mpvArgs` - extra mpv command-line arguments

## Data Directory

```
~/.kittycli/
├── watchlist.json        # Your anime list and progress
├── search-history.json   # Previous searches
├── settings.json         # Your configuration
├── progress.json         # Episode resume points
├── subs/                 # Downloaded subtitles
└── debug.log            # Debug logs
```

## AniList ID Support

The app uses AniList IDs for direct, instant streaming across all **21 providers** via the stream-direct endpoint.

### Stream-Direct Endpoint
The fastest way to get video streams with a single API call:
- Single call returns all available servers for an episode
- Automatically handles HLS/MP4/MKV formats
- Returns multiple server options to choose from
- Includes subtitle tracks, quality info, and headers

Example:
```
GET /provider/Miruro/stream-direct?anilistId=20&episode=1&audio=sub
```

Response includes:
- Primary stream URL with headers (Referer, Origin)
- `allServers` array with multiple CDN options
- Quality information for each server
- Subtitle tracks with language labels
- Provider and server metadata

When available, the CLI automatically:
1. Calls `/stream-direct` for one-call streaming (fastest)
2. If multiple servers available, lets you select your preferred CDN
3. Falls back to traditional search/episodes/servers flow if needed

Supported providers with direct AniList streaming (21 total):
Miruro, MKissa, ReAnime, KickAssAnime, Animo, AniZone, Anikoto, AnimeGG, Senshi, Animetsu, AnimeOnsen, AllAnime, Nyanime, AniDao, Animeverse, AnimeHeaven, AniNeko, AnimeParadise, KaaLt, AniDB, Anineko

## Troubleshooting

**Video won't play**
- Ensure mpv is installed and in PATH
- Try a different provider
- Add to settings: `"mpvArgs": "--demuxer-lavf-o=analyzeduration=30000000,probesize=100000000,fflags=+discardcorrupt"`

**Downloads fail**
- Check disk space
- Verify ffmpeg is installed
- Check network connection

**Provider blocked**
- Try different provider or region
- Check internet connection
- Try without VPN

## Advanced

Enable debug logging:
```bash
DEBUG=true kittycli
```

Custom API endpoint in `~/.kittycli/settings.json`:
```json
{
  "apiBaseUrl": "https://your-backend.com"
}
```

Default: `https://kittyapi.buzz`

## Community & Support

Join the KittyCLI community on Discord for support, updates, and discussions:

- **Discord Server**: https://discord.gg/qBVQqSpqaB
- **GitHub Repository**: https://github.com/fampep/Kitty-cli
- **Report Issues**: https://github.com/fampep/Kitty-cli/issues

## License

GPL-3.0

For more info: https://github.com/fampep/Kitty-cli