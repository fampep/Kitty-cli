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

## Stream-Direct API

The fastest way to get video streams using AniList IDs. Single API call returns all available servers, quality options, and metadata for an episode.

### Endpoint Format
```
GET /provider/{provider}/stream-direct?anilistId={id}&episode={ep}&audio={audio}
```

### Example Request
```
GET /provider/Miruro/stream-direct?anilistId=20&episode=1&audio=sub
```

### Example Response
```json
{
  "file": "https://cdn.example.com/video.m3u8",
  "headers": {
    "Referer": "https://miruro.tv/",
    "Origin": "https://miruro.tv"
  },
  "tracks": [
    {
      "file": "https://subtitle.url/...",
      "label": "English",
      "srclang": "en",
      "kind": "subtitles"
    }
  ],
  "allServers": [
    {
      "file": "https://cdn1.example.com/video.m3u8",
      "quality": "HD-1",
      "headers": { "Referer": "https://miruro.tv/" }
    },
    {
      "file": "https://cdn2.example.com/video.m3u8",
      "quality": "HD-2",
      "headers": { "Referer": "https://miruro.tv/" }
    }
  ],
  "provider": "Miruro",
  "server": "Kwik.cx HLS",
  "episode": 1,
  "anilistId": 20,
  "cached": false
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `file` | string | Primary stream URL |
| `headers` | object | HTTP headers (Referer, Origin, etc.) |
| `tracks` | array | Subtitle tracks with language info |
| `allServers` | array | All available CDN servers for this episode |
| `provider` | string | Provider name |
| `server` | string | Server/CDN name |
| `episode` | number | Episode number |
| `anilistId` | number | AniList ID |
| `cached` | boolean | Whether response was cached |

### Code Examples

**JavaScript:**
```javascript
const res = await fetch('https://kittyapi.buzz/provider/Miruro/stream-direct?anilistId=20&episode=1');
const stream = await res.json();
console.log(stream.file);        // Primary stream
console.log(stream.allServers);  // All available servers
```

**PowerShell:**
```powershell
$stream = Invoke-WebRequest "https://kittyapi.buzz/provider/Miruro/stream-direct?anilistId=20&episode=1" -UseBasicParsing | ConvertFrom-Json
mpv $stream.file
```

**cURL:**
```bash
curl "https://kittyapi.buzz/provider/Miruro/stream-direct?anilistId=20&episode=1&audio=sub" | jq '.file'
```

### Supported Providers (16 Total)

Miruro, anitaku, MKissa, AniZone, Anikoto, AnimeGG, AllAnime, Nyanime, AniDao, Animeverse, AnimeHeaven, AniNeko, AnimeParadise, KaaLt, AniDB, Anineko

### Features

- **Single API Call** - Get complete stream info in one request
- **Multiple Servers** - `allServers` array with all available CDNs
- **Auto Headers** - Proper Referer/Origin headers included
- **Subtitle Support** - Built-in subtitle track information
- **Quality Info** - Multiple quality options per server
- **Caching** - 30-minute TTL for repeated requests
- **Fast Failover** - CLI automatically selects from available servers

### In the CLI

When available, the CLI automatically:
1. Uses stream-direct for one-call streaming (fastest)
2. Lets you select from multiple servers if available
3. Handles headers and authentication automatically
4. Falls back to traditional search if needed

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