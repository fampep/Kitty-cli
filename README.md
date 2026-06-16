KITTYCLI - Anime Terminal Streaming Client

OVERVIEW

Kittycli is a terminal-based anime streaming and management application that aggregates multiple providers, allowing you to search, stream, download, and track anime series all from the command line.

INSTALLATION

Global (recommended):
  npm install -g @fampep/kittycli

Local development:
  npm install
  node kittycli.js

REQUIREMENTS

  Node.js 18 or higher
  mpv (for streaming episodes) - install via:
    Windows: choco install mpv or winget install mpv.net
    macOS: brew install mpv
    Linux: apt install mpv (Ubuntu/Debian) or pacman -S mpv (Arch)
  
  ffmpeg (optional, for HLS stream downloads) - install via:
    Windows: choco install ffmpeg or winget install ffmpeg
    macOS: brew install ffmpeg
    Linux: apt install ffmpeg (Ubuntu/Debian) or pacman -S ffmpeg (Arch)

QUICK START

1. Run the application:
   kittycli

2. From the main menu, select "Search anime" to find a series

3. Browse results and select a provider/episode to stream

4. Episodes will play in mpv player and your progress is automatically saved

FEATURES

Multi-Provider Search
  Search across 15+ anime providers simultaneously and find the best stream

Streaming
  Watch episodes directly in mpv with automatic quality selection and subtitle support

Downloads
  Download episodes in MKV or MP4 format with resumable progress and parallel batch processing

Watchlist
  Keep track of watched episodes with automatic progress saving and resume position

Binge Mode
  Automatic countdown between episodes with instant skip to next episode

Subtitle Management
  Auto-download and manage subtitle files organized by series

AniList Integration
  Fetch episode titles, airing schedules, and metadata directly from AniList

Discord Rich Presence
  Show what you are watching to your Discord friends (optional)

Progress Tracking
  Automatic resume points for each episode saved locally

USAGE

Main Menu Options:

  Search anime
    Search for any anime by title, find results across multiple providers, and stream or download

  Recent searches
    Quick access to previously searched titles

  Watchlist
    Manage your anime watchlist with episode tracking and resume functionality

  Quick resume
    Instantly play the next unwatched episode from your watchlist

  Providers
    View status of all connected providers and their health metrics

  Settings
    Configure download format, quality, playback speed, audio preference, and more

  Help
    Display keyboard shortcuts and feature overview

KEYBOARD NAVIGATION

  UP/DOWN arrows    Move through menu items
  ENTER             Select current item
  1-9               Quick-jump to visible item number
  HOME/END          Jump to top or bottom of menu
  PAGE UP/DOWN      Move by one page
  Q/ESC             Go back in menu hierarchy
  ?                 Show help screen
  CTRL+C            Exit application

BINGE MODE CONTROLS (between episodes)

  Y or ENTER        Continue to next episode immediately
  N                 Stop and return to menu
  A                 Toggle between SUB and DUB audio

CONFIGURATION

Settings are stored in: ~/.kittycli/settings.json

Configurable options:
  bingeCountdownSeconds    Countdown between episodes (default: 8 seconds)
  defaultAudio            Default audio preference (sub or dub)
  playbackSpeed          Video playback speed (0.5x to 3.0x, default: 1.0x)
  downloadFormat         Download format (mkv or mp4, default: mkv)
  downloadConcurrency    Parallel downloads (1-5, default: 2)
  resumePlayback         Auto-resume from last position (default: true)
  preferredQuality       Quality selection (auto, 1080p, 720p, etc)
  discordEnabled        Show Discord Rich Presence (default: false)

DATA DIRECTORY

  ~/.kittycli/
    watchlist.json          Your anime watchlist and progress
    search-history.json     Previously searched titles
    settings.json           User configuration
    progress.json           Playback position history
    subs/                   Downloaded subtitle files
    debug.log               Debug information (if enabled)

ANILIST ID SUPPORT

The application now supports direct streaming using AniList IDs for the fastest experience.

When you select an anime to watch, it automatically detects the AniList ID and uses the optimized stream-direct endpoint for instant streaming across all 19 supported providers:
  Miruro, MKissa, ReAnime, KickAssAnime, Animo, AniZone, Anikoto, AnimeGG, Senshi, Animetsu, AnimeOnsen, AllAnime, Nyanime, AniDao, Animeverse, AnimeHeaven, AniNeko, AnimeParadise, AniDB

The stream-direct endpoint delivers:
  Instant stream URLs (no multiple API calls)
  Automatic quality selection
  Built-in subtitle support
  Response caching for faster repeated access

ADVANCED SETTINGS

To enable debug logging:
  DEBUG=true kittycli

To use a custom API endpoint:
  Edit ~/.kittycli/settings.json and set apiBaseUrl to your backend server
  
  Default: https://kittyapi.buzz
  Alternative backends are supported as long as they implement the stream-direct endpoint

TROUBLESHOOTING

Video won't play
  Ensure mpv is installed and in your PATH
  Check if the stream URL is still active
  Try a different quality/provider
  Increase FFmpeg analysis time in settings: mpvArgs: "--demuxer-lavf-o=analyzeduration=30000000,probesize=100000000,fflags=+discardcorrupt"

Download errors
  Check available disk space
  Ensure ffmpeg is installed for HLS streams
  Try downloading at a different time
  Check the debug log for error details

Provider issues
  Some providers may be blocked in your region
  Try switching to a different provider
  Check your internet connection
  Disable VPN if it interferes with provider access

License
  GPL-3.0

For more information, visit: https://github.com/fampep/Kitty-cli