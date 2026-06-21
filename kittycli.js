#!/usr/bin/env node

import axios from 'axios';
import { spawn, execSync, exec } from 'child_process';
import readline from 'readline';
import path from 'path';
import os from 'os';
import fs from 'fs';
import net from 'net';
import DiscordRPC from 'discord-rpc';
import i18n, { t, loadLanguage, setLanguage, getAvailableLanguages, getLanguageName } from './i18n.js';

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const C = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    italic: "\x1b[3m",
    underline: "\x1b[4m",
    black: "\x1b[30m",
    red: "\x1b[31m",
    green: "\x1b[92m",
    yellow: "\x1b[93m",
    blue: "\x1b[94m",
    magenta: "\x1b[95m",
    cyan: "\x1b[96m",
    white: "\x1b[97m",
    bgBlack: "\x1b[40m",
    bgRed: "\x1b[41m",
    bgGreen: "\x1b[42m",
    bgYellow: "\x1b[43m",
    bgBlue: "\x1b[44m",
    bgMagenta: "\x1b[45m",
    bgCyan: "\x1b[46m",
    bgWhite: "\x1b[47m"
};

const APP_VERSION = "2.6.5";
const GITLAB_PROJECT = "fampep/kitty-cli";
const VERSION_CHECK_URL = `https://gitlab.com/api/v4/projects/${encodeURIComponent(GITLAB_PROJECT)}/releases/permalink/latest`;
const GITHUB_URL = "https://github.com/fampep/Kitty-cli";

const DATA_DIR = path.join(os.homedir(), '.kittycli');
const WATCHLIST_PATH = path.join(DATA_DIR, 'watchlist.json');
const SEARCH_HISTORY_PATH = path.join(DATA_DIR, 'search-history.json');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const PROGRESS_PATH = path.join(DATA_DIR, 'progress.json');
const LOG_PATH = path.join(DATA_DIR, 'debug.log');

if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o755 }); } catch(e) {}
}

const defaultSettings = {
    bingeCountdownSeconds: 8,
    pageSize: 10,
    apiBaseUrl: "https://kittyapi.buzz",
    defaultAudio: "sub",
    mpvArgs: "",
    playbackSpeed: 1.0,
    enableUpdateCheck: true,
    autoPlayNext: false,
    discordEnabled: false,
    discordClientId: "1511784156340818222",
    downloadDir: path.join(os.homedir(), 'Downloads'),
    downloadConcurrency: 2,
    downloadFormat: "mkv",
    resumePlayback: true,
    preferredQuality: "auto",
    cacheTTL: 600000,
    cacheMaxSize: 50,
    maxRetries: 3,
    requestTimeout: 30000,
    autoSelectBestMatch: true,
    minSimilarityScore: 25,
    enableNotifications: true,
    autoRetryFailed: true,
    subtitleLanguage: "english",
    logLevel: "info",
    autoBackup: true,
    maxHistorySize: 50,
    confirmBeforeExit: false,
    language: "en",
    enabledProviders: [
        "Miruro", "anitaku", "MKissa", "AniZone", "Anikoto",
        "AnimeGG", "AllAnime", "Nyanime", "AniDao",
        "Animeverse", "AnimeHeaven", "AniNeko", "AnimeParadise", "KaaLt", "AniDB", "Anineko"
    ]
};

let discordRpc = null;
let discordReady = false;
let currentDiscordActivity = null;
const DEBUG = process.argv.includes('--debug');

function debugLog(...args) {
    if (DEBUG) {
        const timestamp = new Date().toISOString();
        console.error('[DEBUG]', ...args);
        try { fs.appendFileSync(LOG_PATH, `[${timestamp}] ${args.join(' ')}\n`); } catch(e) {}
    }
}

let searchCache = new Map();
let episodeListCache = new Map();
let streamCache = new Map();
let streamDirectCache = new Map();

function cleanCache(cache, maxSize, ttl) {
    const now = Date.now();
    for (const [key, value] of cache.entries()) {
        if (now - value.timestamp > ttl) cache.delete(key);
    }
    if (cache.size > maxSize) {
        const oldest = Array.from(cache.entries()).sort((a,b) => a[1].timestamp - b[1].timestamp);
        for (let i = 0; i < oldest.length - maxSize; i++) cache.delete(oldest[i][0]);
    }
}

function clearAllCaches() {
    searchCache.clear();
    episodeListCache.clear();
    streamCache.clear();
    streamDirectCache.clear();
}

function openUrl(url) {
    const plat = os.platform();
    let cmd;
    if (plat === 'win32') cmd = `start "" "${url}"`;
    else if (plat === 'darwin') cmd = `open "${url}"`;
    else cmd = `xdg-open "${url}"`;
    exec(cmd, (err) => { if (err) debugLog(`Failed to open URL: ${err.message}`); });
}

function initDiscordRpc(clientId) {
    if (discordRpc) return;
    try {
        DiscordRPC.register(clientId);
        discordRpc = new DiscordRPC.Client({ transport: 'ipc' });
        discordRpc.on('ready', () => {
            discordReady = true;
            console.log(`  ${C.green}✓ Discord RPC connected${C.reset}`);
        });
        discordRpc.login({ clientId }).catch(err => {
            debugLog(`Discord RPC login failed: ${err.message}`);
            discordReady = false;
        });
    } catch(err) {
        debugLog(`Failed to initialize Discord RPC: ${err.message}`);
        discordReady = false;
    }
}

function setDiscordPresence(animeTitle, episodeNum, totalEpisodes, audio, streamUrl, providerName, serverName) {
    if (!discordReady || !discordRpc) return;
    const state = totalEpisodes
        ? `Episode ${episodeNum}/${totalEpisodes} · ${audio.toUpperCase()} · ${providerName}`
        : `Episode ${episodeNum} · ${audio.toUpperCase()} · ${providerName}`;
    const details = `Watching ${animeTitle.substring(0, 128)}`;
    if (currentDiscordActivity && currentDiscordActivity.details === details && currentDiscordActivity.state === state) return;
    currentDiscordActivity = { details, state };
    discordRpc.setActivity({
        details: details,
        state: state,
        startTimestamp: Date.now(),
        largeImageKey: 'kitty_logo',
        largeImageText: `KittyCLI v${APP_VERSION}`,
        smallImageKey: 'play',
        smallImageText: 'Streaming',
        buttons: [
            { label: '🎬 Watch Episode', url: streamUrl.substring(0, 512) },
            { label: '🐱 GitHub', url: GITHUB_URL }
        ],
        instance: false
    }).catch(err => debugLog('Discord RPC setActivity error:', err.message));
}

function clearDiscordPresence() {
    if (!discordReady || !discordRpc) return;
    currentDiscordActivity = null;
    discordRpc.clearActivity().catch(err => debugLog('Discord RPC clear error:', err.message));
}

function sendNotification(title, message) {
    const settings = loadSettings();
    if (!settings.enableNotifications) return;
    const plat = os.platform();
    try {
        if (plat === 'linux') {
            execSync(`notify-send "${title.replace(/"/g, '\\"')}" "${message.replace(/"/g, '\\"')}"`, { stdio: 'ignore' });
        } else if (plat === 'darwin') {
            execSync(`osascript -e 'display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"'`, { stdio: 'ignore' });
        } else if (plat === 'win32') {
            const psScript = `New-BurntToastNotification -Text "${title}", "${message}"`;
            execSync(`powershell -Command "${psScript}"`, { stdio: 'ignore' });
        }
    } catch(e) { debugLog(`Notification failed: ${e.message}`); }
}

function levenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            const cost = a[j - 1] === b[i - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i-1][j] + 1,
                matrix[i][j-1] + 1,
                matrix[i-1][j-1] + cost
            );
        }
    }
    return matrix[b.length][a.length];
}

function similarityScore(a, b) {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
    return 1 - distance / maxLen;
}

function stripHtmlTags(text) {
    if (!text) return '';
    return text.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function checkForUpdates() {
    try {
        const response = await axios.get(VERSION_CHECK_URL, { timeout: 5000 });
        const latest = response.data.tag_name?.replace(/^v/, '');
        if (latest && latest !== APP_VERSION) return latest;
        return null;
    } catch(e) { return null; }
}

async function fetchAnimeMetadata(title) {
    try {
        const query = `
            query ($search: String) {
                Media (search: $search, type: ANIME) {
                    id description(asHtml: false) averageScore genres episodes status season seasonYear
                }
            }
        `;
        const response = await axios.post('https://graphql.anilist.co',
            { query, variables: { search: title } },
            { timeout: 4000 }
        );
        const media = response.data.data?.Media;
        if (media) {
            return {
                synopsis: media.description ? media.description.substring(0, 500) + (media.description.length > 500 ? '...' : '') : 'No description available.',
                rating: media.averageScore ? media.averageScore / 10 : undefined,
                genres: media.genres || [],
                episodes: media.episodes,
                season: media.season,
                seasonYear: media.seasonYear,
                status: media.status,
                anilistId: media.id
            };
        }
    } catch(e) { debugLog(`Metadata fetch failed: ${e.message}`); }
    return null;
}

async function fetchAnilistEpisodes(anilistId) {
    try {
        const query = `
            query ($id: Int, $page: Int) {
                Media(id: $id, type: ANIME) {
                    id
                    title { romaji english native }
                    season seasonYear episodes status
                    airingSchedule(page: $page, perPage: 50) {
                        pageInfo { hasNextPage currentPage }
                        edges {
                            node {
                                episode airingAt
                            }
                        }
                    }
                }
            }
        `;

        let allEpisodes = {};
        let page = 1;
        let hasNextPage = true;

        while (hasNextPage && page <= 5) {
            const response = await axios.post('https://graphql.anilist.co',
                { query, variables: { id: anilistId, page } },
                { timeout: 5000 }
            );
            const media = response.data.data?.Media;
            if (!media) break;

            if (media.airingSchedule?.edges) {
                media.airingSchedule.edges.forEach(edge => {
                    if (edge.node.episode) {
                        allEpisodes[edge.node.episode] = {
                            episode: edge.node.episode,
                            airingAt: edge.node.airingAt
                        };
                    }
                });
            }

            hasNextPage = media.airingSchedule?.pageInfo?.hasNextPage || false;
            page++;
        }

        const mediaQuery = `
            query ($id: Int) {
                Media(id: $id, type: ANIME) {
                    id title { romaji english native } season seasonYear episodes status
                }
            }
        `;
        const mediaResponse = await axios.post('https://graphql.anilist.co',
            { query: mediaQuery, variables: { id: anilistId } },
            { timeout: 5000 }
        );
        const media = mediaResponse.data.data?.Media;

        return {
            title: media?.title?.romaji || media?.title?.english || 'Unknown',
            episodes: media?.episodes,
            season: media?.season,
            seasonYear: media?.seasonYear,
            status: media?.status,
            anilistId: anilistId,
            episodeTimes: allEpisodes
        };
    } catch(e) { debugLog(`AniList episodes fetch failed: ${e.message}`); }
    return null;
}

async function fetchTotalEpisodesFromWorker(title, anilistId, apiBaseUrl) {
    const base = apiBaseUrl || loadSettings().apiBaseUrl;
    try {
        let url;
        if (anilistId) url = `${base}/total-episodes/${anilistId}`;
        else url = `${base}/total-episodes-by-title?q=${encodeURIComponent(title)}`;
        const response = await axios.get(url, { timeout: 5000 });
        const data = response.data;
        if (data && (data.totalEpisodes !== undefined || data.totalEpisodes === null)) {
            return { totalEpisodes: data.totalEpisodes, status: data.status || null, anilistId: data.anilistId || anilistId || null };
        }
        return null;
    } catch(e) { return null; }
}

function loadWatchlist() {
    try {
        if (fs.existsSync(WATCHLIST_PATH)) return JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
    } catch(e) {}
    return [];
}

function saveWatchlist(list) {
    try { fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(list, null, 2), 'utf8'); } catch(e) {}
}

function loadProgress() {
    try {
        if (fs.existsSync(PROGRESS_PATH)) return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
    } catch(e) {}
    return {};
}

function saveProgress(progress) {
    try { fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), 'utf8'); } catch(e) {}
}

function saveToWatchlist(title, episode, audio, selectedMatches, totalEpisodes, anilistId, position = 0, quality = null, seasonInfo = null) {
    try {
        const list = loadWatchlist();
        const existingIdx = list.findIndex(item => item.title.toLowerCase() === title.toLowerCase());
        const matchesData = selectedMatches.map(m => ({
            providerName: m.provider.name,
            url: m.item.url,
            hasSub: m.item.hasSub,
            hasDub: m.item.hasDub
        }));
        const newItem = {
            title, lastEpisode: episode, audio, timestamp: new Date().toISOString(),
            matches: matchesData, totalEpisodes, anilistId, position, quality, lastWatched: Date.now()
        };
        if (seasonInfo) {
            newItem.season = seasonInfo.season;
            newItem.seasonYear = seasonInfo.seasonYear;
        }
        if (existingIdx !== -1) {
            if (totalEpisodes === undefined && list[existingIdx].totalEpisodes) newItem.totalEpisodes = list[existingIdx].totalEpisodes;
            if (anilistId === undefined && list[existingIdx].anilistId) newItem.anilistId = list[existingIdx].anilistId;
            newItem.position = position || list[existingIdx].position || 0;
            newItem.quality = quality || list[existingIdx].quality || null;
            if (!seasonInfo && list[existingIdx].season) newItem.season = list[existingIdx].season;
            if (!seasonInfo && list[existingIdx].seasonYear) newItem.seasonYear = list[existingIdx].seasonYear;
            list[existingIdx] = newItem;
        } else list.unshift(newItem);
        saveWatchlist(list);
    } catch(e) {}
}

function updateWatchlistPosition(title, episode, position) {
    const list = loadWatchlist();
    const idx = list.findIndex(item => item.title.toLowerCase() === title.toLowerCase());
    if (idx !== -1 && list[idx].lastEpisode === episode) {
        list[idx].position = position;
        saveWatchlist(list);
    }
    const progress = loadProgress();
    const key = `${title}|${episode}`;
    progress[key] = position;
    saveProgress(progress);
}

function getResumePosition(title, episode) {
    const list = loadWatchlist();
    const idx = list.findIndex(item => item.title.toLowerCase() === title.toLowerCase());
    if (idx !== -1 && list[idx].lastEpisode === episode && list[idx].position) {
        return list[idx].position;
    }
    const progress = loadProgress();
    const key = `${title}|${episode}`;
    return progress[key] || 0;
}

function deleteWatchlistItem(index) {
    const list = loadWatchlist();
    if (index >= 0 && index < list.length) { list.splice(index, 1); saveWatchlist(list); }
}

function updateWatchlistEpisode(title, newEpisode) {
    const list = loadWatchlist();
    const idx = list.findIndex(item => item.title.toLowerCase() === title.toLowerCase());
    if (idx !== -1) { list[idx].lastEpisode = newEpisode; list[idx].position = 0; saveWatchlist(list); }
}

function updateWatchlistAudio(title, audio) {
    const list = loadWatchlist();
    const idx = list.findIndex(item => item.title.toLowerCase() === title.toLowerCase());
    if (idx !== -1) { list[idx].audio = audio; saveWatchlist(list); }
}

function clearWatchlist() { 
    try { if (fs.existsSync(WATCHLIST_PATH)) fs.unlinkSync(WATCHLIST_PATH); } catch(e) {} 
}

function readJsonFile(filePath, fallback) {
    try { if (!fs.existsSync(filePath)) return fallback; return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch(e) { return fallback; }
}

function writeJsonFile(filePath, value) { try { fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8'); } catch(e) {} }

function loadSettings() {
    const stored = readJsonFile(SETTINGS_PATH, {});
    return {
        bingeCountdownSeconds: typeof stored.bingeCountdownSeconds === "number" ? Math.min(Math.max(stored.bingeCountdownSeconds, 3), 120) : defaultSettings.bingeCountdownSeconds,
        pageSize: typeof stored.pageSize === "number" ? Math.min(Math.max(stored.pageSize, 6), 20) : defaultSettings.pageSize,
        apiBaseUrl: typeof stored.apiBaseUrl === "string" && stored.apiBaseUrl.trim() ? stored.apiBaseUrl.trim() : defaultSettings.apiBaseUrl,
        defaultAudio: stored.defaultAudio === "dub" ? "dub" : "sub",
        mpvArgs: typeof stored.mpvArgs === "string" ? stored.mpvArgs : defaultSettings.mpvArgs,
        playbackSpeed: typeof stored.playbackSpeed === "number" ? Math.min(Math.max(stored.playbackSpeed, 0.5), 3.0) : 1.0,
        enableUpdateCheck: typeof stored.enableUpdateCheck === "boolean" ? stored.enableUpdateCheck : true,
        autoPlayNext: typeof stored.autoPlayNext === "boolean" ? stored.autoPlayNext : false,
        discordEnabled: typeof stored.discordEnabled === "boolean" ? stored.discordEnabled : false,
        discordClientId: typeof stored.discordClientId === "string" && stored.discordClientId.trim() ? stored.discordClientId.trim() : defaultSettings.discordClientId,
        downloadDir: typeof stored.downloadDir === "string" && stored.downloadDir.trim() ? stored.downloadDir.trim() : defaultSettings.downloadDir,
        downloadConcurrency: typeof stored.downloadConcurrency === "number" ? Math.min(Math.max(stored.downloadConcurrency, 1), 5) : defaultSettings.downloadConcurrency,
        downloadFormat: stored.downloadFormat === "mp4" ? "mp4" : "mkv",
        resumePlayback: typeof stored.resumePlayback === "boolean" ? stored.resumePlayback : true,
        preferredQuality: typeof stored.preferredQuality === "string" ? stored.preferredQuality : defaultSettings.preferredQuality,
        cacheTTL: typeof stored.cacheTTL === "number" ? stored.cacheTTL : defaultSettings.cacheTTL,
        cacheMaxSize: typeof stored.cacheMaxSize === "number" ? stored.cacheMaxSize : defaultSettings.cacheMaxSize,
        maxRetries: typeof stored.maxRetries === "number" ? stored.maxRetries : defaultSettings.maxRetries,
        requestTimeout: typeof stored.requestTimeout === "number" ? stored.requestTimeout : defaultSettings.requestTimeout,
        autoSelectBestMatch: typeof stored.autoSelectBestMatch === "boolean" ? stored.autoSelectBestMatch : defaultSettings.autoSelectBestMatch,
        minSimilarityScore: typeof stored.minSimilarityScore === "number" ? stored.minSimilarityScore : defaultSettings.minSimilarityScore,
        enableNotifications: typeof stored.enableNotifications === "boolean" ? stored.enableNotifications : defaultSettings.enableNotifications,
        autoRetryFailed: typeof stored.autoRetryFailed === "boolean" ? stored.autoRetryFailed : defaultSettings.autoRetryFailed,
        logLevel: typeof stored.logLevel === "string" ? stored.logLevel : defaultSettings.logLevel,
        autoBackup: typeof stored.autoBackup === "boolean" ? stored.autoBackup : defaultSettings.autoBackup,
        confirmBeforeExit: typeof stored.confirmBeforeExit === "boolean" ? stored.confirmBeforeExit : defaultSettings.confirmBeforeExit,
        language: typeof stored.language === "string" && stored.language ? stored.language : defaultSettings.language,
        enabledProviders: Array.isArray(stored.enabledProviders) && stored.enabledProviders.length > 0 ? stored.enabledProviders : defaultSettings.enabledProviders
    };
}

function saveSettings(settings) { writeJsonFile(SETTINGS_PATH, settings); }

function loadSearchHistory() {
    const history = readJsonFile(SEARCH_HISTORY_PATH, []);
    return Array.isArray(history) ? history.filter(item => typeof item === "string" && item.trim()).slice(0, 50) : [];
}

function saveSearchToHistory(query) {
    const clean = query.trim();
    if (!clean) return;
    const next = [clean, ...loadSearchHistory().filter(item => item.toLowerCase() !== clean.toLowerCase())].slice(0, 50);
    writeJsonFile(SEARCH_HISTORY_PATH, next);
}

function deleteSearchHistoryItem(index) {
    const history = loadSearchHistory();
    if (index >= 0 && index < history.length) { history.splice(index, 1); writeJsonFile(SEARCH_HISTORY_PATH, history); }
}

function clearSearchHistory() { try { if (fs.existsSync(SEARCH_HISTORY_PATH)) fs.unlinkSync(SEARCH_HISTORY_PATH); } catch(e) {} }

function clearScreen() { console.clear(); }

// FIXED: Safe string padding functions with bounds checking
function stripAnsi(value) { 
    return value.replace(/\x1b\[[0-9;]*m/g, ""); 
}

function visibleLength(value) { 
    return stripAnsi(value).length; 
}

// FIXED: Ensures we never pass negative values to repeat()
function padRightVisible(value, width) { 
    const visible = visibleLength(value);
    if (visible >= width) return value;
    const padding = Math.max(0, width - visible);
    return value + " ".repeat(padding); 
}

// Enhanced box rendering with better visual formatting
function renderBox(title, content, color = C.green) {
    const maxLen = Math.max(title.length, ...content.map(l => visibleLength(l))) + 4;
    const safeLen = Math.max(1, maxLen); // Ensure at least 1

    const top = `${color}┌${"─".repeat(Math.max(0, safeLen))}┐${C.reset}`;
    const titlePadding = Math.max(0, safeLen - title.length - 1);
    const titleLine = `${color}│${C.reset} ${C.bold}${color}${title}${C.reset}${" ".repeat(titlePadding)}${color}│${C.reset}`;
    const mid = `${color}├${"─".repeat(Math.max(0, safeLen))}┤${C.reset}`;
    const bottom = `${color}└${"─".repeat(Math.max(0, safeLen))}┘${C.reset}`;

    console.log();
    console.log(top);
    console.log(titleLine);
    console.log(mid);
    for (const line of content) {
        const padding = Math.max(0, safeLen - visibleLength(line) - 1);
        console.log(`${color}│${C.reset} ${line}${" ".repeat(padding)}${color}│${C.reset}`);
    }
    console.log(bottom);
    console.log();
}

function renderHeader(title, subtitle) {
    const cat = `
${C.cyan}${C.bold}        /\\_____/\\     /\\_____/\\${C.reset}
${C.cyan}${C.bold}       /  o   o  \\   /  o   o  \\${C.reset}
${C.green}${C.bold}      ( ==  ^  == ) ( ==  ^  == )${C.reset}
${C.green}${C.bold}       )         (   )         (${C.reset}
${C.green}${C.bold}      (           ) (           )${C.reset}
${C.cyan}${C.bold}     ( (  )   (  ) ) (  )   (  ) )${C.reset}
${C.cyan}${C.bold}    (__(__)___(__)__) (__(__)___(__)__)${C.reset}
${C.reset}`;
    const logo = `${C.green}${C.bold}  ██╗  ██╗██╗████████╗████████╗██╗   ██╗ ██████╗██╗     ██╗${C.reset}
${C.cyan}${C.bold}  ██║ ██╔╝██║╚══██╔══╝╚══██╔══╝╚██╗ ██╔╝██╔════╝██║     ██║${C.reset}
${C.green}${C.bold}  █████╔╝ ██║   ██║      ██║    ╚████╔╝ ██║     ██║     ██║${C.reset}
${C.cyan}${C.bold}  ██╔═██╗ ██║   ██║      ██║     ╚██╔╝  ██║     ██║     ██║${C.reset}
${C.green}${C.bold}  ██║  ██╗██║   ██║      ██║      ██║   ╚██████╗███████╗██║${C.reset}
${C.cyan}${C.bold}  ╚═╝  ╚═╝╚═╝   ╚═╝      ╚═╝      ╚═╝    ╚═════╝╚══════╝╚═╝${C.reset}`;
    console.log(cat);
    console.log(logo);
    const width = 62;
    const line = "═".repeat(width);
    const center = (value) => {
        const cleanLength = visibleLength(value);
        const left = Math.max(0, Math.floor((width - cleanLength) / 2));
        return " ".repeat(left) + value;
    };
    console.log(`\n${C.bold}${C.green}╔${line}╗${C.reset}`);
    console.log(`${C.bold}${C.green}║${C.reset}${center(`${C.bold}${C.cyan}${title}${C.reset}`)}${C.bold}${C.green}║${C.reset}`);
    if (subtitle) console.log(`${C.bold}${C.green}║${C.reset}${center(`${C.dim}${C.yellow}${subtitle}${C.reset}`)}${C.bold}${C.green}║${C.reset}`);
    console.log(`${C.bold}${C.green}╚${line}╝${C.reset}\n`);
}

function renderStatusBar(providersCount, apiUrl, additional) {
    const W = process.stdout.columns || 100;
    const safeW = Math.max(50, W); // Minimum width of 50
    const parts = [
        `${C.bold}${C.green}🐱 kittycli${C.reset} ${C.dim}v${APP_VERSION}${C.reset}`,
        `${C.cyan}${providersCount}${C.reset}${C.dim} providers${C.reset}`,
        `${C.dim}api:${C.reset} ${C.yellow}${apiUrl.length > 30 ? apiUrl.substring(0, 27) + '...' : apiUrl}${C.reset}`,
        additional || `${C.dim}↑↓ move  ↵ select  1-9 jump  q back  ? help${C.reset}`
    ];
    console.log(`\n${C.bold}${C.dim}${"─".repeat(safeW)}${C.reset}`);
    console.log(parts.join(`  ${C.dim}│${C.reset}  `));
    console.log(`${C.bold}${C.dim}${"─".repeat(safeW)}${C.reset}\n`);
}

function normalizeTitle(title) { return title.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim(); }

function resolveEpisodeDataIds(epObj) {
    if (!epObj) return null;
    if (epObj.dataIds != null) return epObj.dataIds;
    if (epObj.id != null) return epObj.id;
    if (epObj.episodeId != null) return epObj.episodeId;
    if (epObj.episode_id != null) return epObj.episode_id;
    if (epObj.data_id != null) return epObj.data_id;
    if (epObj.dataId != null) return epObj.dataId;
    if (epObj.sourceId != null) return epObj.sourceId;
    if (epObj.linkId != null) return epObj.linkId;
    return null;
}

function parseEpisodeNumber(ep) {
    let num = ep.number ?? ep.episode ?? ep.num;
    if (typeof num === 'string') num = parseInt(num, 10);
    if (typeof num === 'number' && !isNaN(num)) return num;
    return null;
}

function getWatchlistInfo(title) {
    const list = loadWatchlist();
    const normalized = normalizeTitle(title);
    const item = list.find(i => normalizeTitle(i.title) === normalized);
    if (item) return { lastEpisode: item.lastEpisode, totalEpisodes: item.totalEpisodes, audio: item.audio, anilistId: item.anilistId, position: item.position || 0, quality: item.quality || null };
    return null;
}

function audioLabel(hasSub, hasDub) {
    if (hasSub && hasDub) return "SUB+DUB";
    if (hasDub) return "DUB";
    return "SUB";
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function pauseForKey(message = "press any key to continue...") {
    console.log(`\n${C.dim}  ${message}${C.reset}`);
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
        await wait(1200);
        return;
    }
    await new Promise((resolve) => {
        const isRaw = process.stdin.isRaw;
        process.stdin.setRawMode(true);
        const onData = () => {
            process.stdin.setRawMode(isRaw);
            process.stdin.removeListener('data', onData);
            resolve();
        };
        process.stdin.once('data', onData);
    });
}

async function withSpinner(message, task) {
    const frames = ['◐', '◓', '◑', '◒'];
    let i = 0;
    const interval = setInterval(() => {
        process.stdout.write(`\r  ${C.cyan}${frames[i]}${C.reset} ${C.dim}${message}${C.reset}  `);
        i = (i + 1) % frames.length;
    }, 120);
    try {
        const result = await task();
        clearInterval(interval);
        process.stdout.write(`\r  ${C.green}✓${C.reset} ${message}${" ".repeat(Math.max(0, 30 - message.length))}\n`);
        return result;
    } catch (err) {
        clearInterval(interval);
        process.stdout.write(`\r  ${C.red}✗${C.reset} ${message}${" ".repeat(Math.max(0, 30 - message.length))}\n`);
        throw err;
    }
}

async function withRetry(fn, retries = 3, delay = 1000) {
    let lastError;
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            debugLog(`Retry ${i+1}/${retries} failed:`, err.message);
            if (i === retries - 1) throw err;
            await wait(delay * Math.pow(2, i));
        }
    }
    throw lastError;
}

function isMpvAvailable() {
    const cmd = os.platform() === "win32" ? "where mpv" : "which mpv";
    try { execSync(cmd, { stdio: 'ignore' }); return true; } catch(e) { return false; }
}

async function downloadSubtitle(subtitleUrl, outputPath) {
    try {
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
        }
        const response = await axios({ url: subtitleUrl, method: 'GET', responseType: 'text', timeout: 10000 });
        fs.writeFileSync(outputPath, response.data);
        return true;
    } catch(e) {
        debugLog(`Subtitle download failed: ${e.message}`);
        return false;
    }
}

function selectQuality(qualities, preferred) {
    if (!qualities || qualities.length === 0) return null;
    const sorted = [...qualities].sort((a,b) => {
        const getHeight = (q) => {
            const match = String(q).match(/(\d+)p/);
            return match ? parseInt(match[1]) : 0;
        };
        return getHeight(b) - getHeight(a);
    });
    if (preferred === 'auto') return sorted[0];
    const found = sorted.find(q => String(q).toLowerCase().includes(preferred.toLowerCase()));
    return found || sorted[0];
}

async function playWithMpv(stream, displayTitle, settings, animeTitle, episodeNum, totalEpisodes, audio, providerName, serverName) {
    if (!isMpvAvailable()) {
        renderBox(t('app.error'), [t('errors.mpvNotInstalled')], C.red);
        return false;
    }
    if (settings.discordEnabled && discordReady && stream && stream.file) {
        setDiscordPresence(animeTitle, episodeNum, totalEpisodes, audio, stream.file, providerName, serverName);
    }
    return new Promise(async (resolve) => {
        console.log(`\n  ${C.cyan}◈${C.reset} ${C.bold}${t('streaming.launching')}${C.reset}`);

        // Extract headers from response, with fallback to older formats
        let referrer = '';
        let origin = '';

        if (stream.headers && typeof stream.headers === 'object') {
            referrer = stream.headers.Referer || stream.headers.referer || '';
            origin = stream.headers.Origin || stream.headers.origin || '';
        }
        // Fallback to direct properties
        if (!referrer) referrer = stream.referer || '';
        if (!origin) origin = stream.origin || '';

        // Use stream URL as fallback referrer if not provided
        if (!referrer && stream.file) referrer = stream.file;
        const subsDir = path.join(DATA_DIR, 'subs', animeTitle.replace(/[<>:"/\\|?*]/g, '_'));
        const audioLabel = audio === "dub" ? "DUB" : "SUB";
        const speedLabel = settings.playbackSpeed !== 1.0 ? ` @ ${settings.playbackSpeed}x` : "";
        const playerTitle = `${animeTitle} S${String(episodeNum).padStart(2, '0')} | ${displayTitle} | ${providerName} • ${serverName} | ${audioLabel}${speedLabel} | KittyCLI v${APP_VERSION}`;
        let baseArgs = [
            stream.file,
            `--referrer=${referrer}`,
            `--http-header-fields=Origin: ${origin}`,
            "--keep-open=no",
            "--save-position-on-quit=yes",
            "--resume-playback=yes",
            `--speed=${settings.playbackSpeed}`,
            `--title=${playerTitle.substring(0, 200)}`
        ];
        if (stream.file && stream.file.includes('.m3u8')) {
            baseArgs.push('--demuxer-lavf-o=analyzeduration=60000000,probesize=200000000,fflags=+discardcorrupt+nobuffer');
        }
        if (fs.existsSync(subsDir)) {
            baseArgs.push(`--sub-file-paths=${subsDir}`);
        }
        let resumePos = 0;
        if (settings.resumePlayback) {
            resumePos = getResumePosition(animeTitle, episodeNum);
            if (resumePos > 5) {
                baseArgs.push(`--start=${resumePos}`);
                console.log(`  ${C.dim}resuming from ${Math.floor(resumePos/60)}:${(resumePos%60).toString().padStart(2,'0')}${C.reset}`);
            }
        }
        let args = baseArgs;
        if (settings.mpvArgs && settings.mpvArgs.trim()) {
            const extra = settings.mpvArgs.trim().split(/\s+/);
            args = [...baseArgs, ...extra];
        }
        const socketPath = path.join(os.tmpdir(), `mpv-socket-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`);
        args.push(`--input-ipc-server=${socketPath}`);
        const mpv = spawn('mpv', args, { stdio: 'inherit' });
        let lastPosition = resumePos;
        let socket = null;
        let positionInterval = null;
        let retryCount = 0;
        const connectSocket = () => {
            if (!settings.resumePlayback) return;
            const tryConnect = () => {
                socket = net.createConnection(socketPath, () => {
                    debugLog('Connected to mpv IPC');
                    socket.write(JSON.stringify({ command: ["observe_property", 1, "time-pos"] }) + '\n');
                    positionInterval = setInterval(() => {
                        if (socket && !socket.destroyed) {
                            socket.write(JSON.stringify({ command: ["get_property", "time-pos"] }) + '\n');
                        }
                    }, 5000);
                });
                socket.on('data', (data) => {
                    try {
                        const lines = data.toString().split('\n');
                        for (const line of lines) {
                            if (!line.trim()) continue;
                            const msg = JSON.parse(line);
                            if (msg.event === 'property-change' && msg.name === 'time-pos' && typeof msg.data === 'number') {
                                if (msg.data > 5) lastPosition = msg.data;
                            } else if (msg.request_id === undefined && msg.error === undefined && typeof msg.data === 'number') {
                                if (msg.data > 5) lastPosition = msg.data;
                            }
                        }
                    } catch(e) {}
                });
                socket.on('error', (err) => {
                    debugLog('IPC socket error:', err.message);
                    if (retryCount < 3) {
                        retryCount++;
                        setTimeout(tryConnect, 1000);
                    }
                });
            };
            tryConnect();
        };
        connectSocket();
        mpv.on('close', (code) => {
            if (positionInterval) clearInterval(positionInterval);
            if (socket) socket.destroy();
            if (settings.resumePlayback && lastPosition > 10 && Math.abs(lastPosition - resumePos) > 5) {
                updateWatchlistPosition(animeTitle, episodeNum, lastPosition);
            }
            if (settings.discordEnabled && discordReady) clearDiscordPresence();
            resolve(code === 0);
        });
        mpv.on('error', (err) => { 
            console.log(`  ${C.red}✗ mpv error: ${err.message}${C.reset}`);
            if (positionInterval) clearInterval(positionInterval);
            if (socket) socket.destroy();
            if (settings.discordEnabled && discordReady) clearDiscordPresence();
            resolve(false); 
        });
    });
}

async function downloadWithFfmpegProgress(url, outputPath, format = 'mkv') {
    return new Promise((resolve) => {
        const args = ['-i', url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-f', format, '-y', outputPath];
        const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let duration = 0, lastProgress = 0;
        ffmpeg.stderr.on('data', (data) => {
            const str = data.toString();
            const durationMatch = str.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
            if (durationMatch && duration === 0) {
                const hours = parseInt(durationMatch[1]), minutes = parseInt(durationMatch[2]), seconds = parseFloat(durationMatch[3]);
                duration = hours * 3600 + minutes * 60 + seconds;
            }
            const timeMatch = str.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
            if (timeMatch && duration > 0) {
                const hours = parseInt(timeMatch[1]), minutes = parseInt(timeMatch[2]), seconds = parseFloat(timeMatch[3]);
                const current = hours * 3600 + minutes * 60 + seconds;
                const percent = (current / duration) * 100;
                if (Math.floor(percent) > lastProgress) {
                    lastProgress = Math.floor(percent);
                    const filled = Math.min(20, Math.max(0, Math.round(percent / 5)));
                    const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, 20 - filled));
                    process.stdout.write(`\r  ${C.cyan}[${bar}]${C.reset} ${C.bold}${percent.toFixed(1)}%${C.reset}  `);
                }
            }
        });
        ffmpeg.on('close', (code) => {
            console.log();
            if (code === 0) { console.log(`  ${C.green}✓ ${t('download.downloadComplete')}${C.reset}`); sendNotification(t('download.title'), path.basename(outputPath)); resolve(true); }
            else { console.log(`  ${C.red}✗ ffmpeg failed.${C.reset}`); resolve(false); }
        });
        ffmpeg.on('error', (err) => { console.log(`  ${C.red}✗ ffmpeg error: ${err.message}${C.reset}`); resolve(false); });
    });
}

async function resumeableDownload(serverDetails, suggestedFilename, onProgress, format = 'mkv') {
    const settings = loadSettings();
    const cleanFilename = suggestedFilename.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
    const outputDir = settings.downloadDir;
    if (!fs.existsSync(outputDir)) {
        try { fs.mkdirSync(outputDir, { recursive: true }); } catch(e) { return false; }
    }
    const downloadPath = path.join(outputDir, cleanFilename);
    const partPath = downloadPath + '.part';
    const metaPath = downloadPath + '.meta.json';

    let partial = null;
    if (fs.existsSync(partPath) && fs.existsSync(metaPath)) {
        try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            if (meta.url === serverDetails.file && meta.outputPath === downloadPath) {
                partial = meta;
                console.log(`  ${C.yellow}⟳ resuming from ${(partial.downloadedBytes / 1024 / 1024).toFixed(1)} MB${C.reset}`);
            } else {
                fs.unlinkSync(partPath);
                fs.unlinkSync(metaPath);
            }
        } catch(e) {}
    }

    if (!partial) {
        renderBox(t('boxes.savingTo'), [downloadPath], C.cyan);

        // Extract headers with proper fallback chain
        let referer = '';
        let origin = '';

        if (serverDetails.headers && typeof serverDetails.headers === 'object') {
            referer = serverDetails.headers.Referer || serverDetails.headers.referer || '';
            origin = serverDetails.headers.Origin || serverDetails.headers.origin || '';
        }
        // Fallback to direct properties
        if (!referer) referer = serverDetails.referer || '';
        if (!origin) origin = serverDetails.origin || '';
        // Use file URL as last resort for referer
        if (!referer && serverDetails.file) referer = serverDetails.file;

        const headers = { Referer: referer, Origin: origin };
        partial = { url: serverDetails.file, outputPath: downloadPath, downloadedBytes: 0, totalBytes: 0, headers: headers };
    }

    const pd = partial;

    if (serverDetails.file.includes('.m3u8')) {
        console.log(`  ${C.magenta}◈ hls stream detected — using ffmpeg${C.reset}`);
        return downloadWithFfmpegProgress(serverDetails.file, downloadPath, format);
    }

    try {
        const headers = { 'Referer': pd.headers.Referer, 'Origin': pd.headers.Origin, 'User-Agent': USER_AGENT };
        if (pd.downloadedBytes > 0) headers['Range'] = `bytes=${pd.downloadedBytes}-`;

        const response = await axios({ url: pd.url, method: 'GET', responseType: 'stream', headers, timeout: 30000 });

        if (pd.totalBytes === 0) {
            const contentRange = response.headers['content-range'];
            if (contentRange) {
                const match = contentRange.match(/bytes \d+-(\d+)\/\d+/);
                if (match) pd.totalBytes = parseInt(match[1], 10) + 1;
            } else {
                pd.totalBytes = parseInt(String(response.headers['content-length'] || '0'), 10);
            }
        }

        fs.writeFileSync(metaPath, JSON.stringify(pd, null, 2));
        const writer = fs.createWriteStream(partPath, { flags: 'a' });
        let startTime = Date.now();
        let lastUpdate = 0;
        let lastBytes = pd.downloadedBytes;

        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            response.data.on('data', (chunk) => {
                pd.downloadedBytes += chunk.length;
                const now = Date.now();
                if (now - lastUpdate > 200 && pd.totalBytes > 0) {
                    const percent = (pd.downloadedBytes / pd.totalBytes) * 100;
                    const elapsed = (now - startTime) / 1000;
                    const speed = (pd.downloadedBytes - lastBytes) / elapsed / 1024 / 1024;
                    const remaining = pd.totalBytes - pd.downloadedBytes;
                    const eta = remaining / ((pd.downloadedBytes - lastBytes) / elapsed);
                    if (onProgress) onProgress(percent, pd.downloadedBytes/1024/1024, pd.totalBytes/1024/1024, speed, eta);
                    else {
                        const filled = Math.min(28, Math.max(0, Math.round((pd.downloadedBytes / pd.totalBytes) * 28)));
                        const bar = `${C.green}${'█'.repeat(filled)}${C.reset}${C.dim}${'░'.repeat(Math.max(0, 28 - filled))}${C.reset}`;
                        process.stdout.write(`\r  [${bar}] ${C.bold}${percent.toFixed(1)}%${C.reset}  ${C.dim}${(pd.downloadedBytes/1024/1024).toFixed(1)}/${(pd.totalBytes/1024/1024).toFixed(1)} MB  ${speed.toFixed(1)} MB/s  eta ${eta.toFixed(0)}s${C.reset}  `);
                    }
                    lastUpdate = now;
                    lastBytes = pd.downloadedBytes;
                } else if (pd.totalBytes === 0) {
                    process.stdout.write(`\r  ${C.cyan}↓${C.reset} ${(pd.downloadedBytes / 1024 / 1024).toFixed(1)} MB downloaded...  `);
                }
                if (pd.downloadedBytes % (1024 * 1024 * 5) < chunk.length) {
                    fs.writeFileSync(metaPath, JSON.stringify(pd, null, 2));
                }
            });

            writer.on('finish', () => {
                console.log();
                fs.renameSync(partPath, downloadPath);
                if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
                console.log(`  ${C.green}✓ download complete!${C.reset}`);
                sendNotification(t('download.title'), cleanFilename);
                resolve(true);
            });

            writer.on('error', (err) => { fs.writeFileSync(metaPath, JSON.stringify(pd, null, 2)); reject(err); });
            response.data.on('error', (err) => { fs.writeFileSync(metaPath, JSON.stringify(pd, null, 2)); reject(err); });
        });
    } catch (err) {
        renderBox(t('boxes.downloadError'), [err.message], C.red);
        return false;
    }
}

async function batchDownloadQueue(jobs, coreTitle, statusBar, selectedQuality = null) {
    const settings = loadSettings();
    const concurrency = settings.downloadConcurrency;
    console.log(`\n  ${C.bold}${C.green}◈ batch download  ${C.cyan}${jobs.length} episodes${C.reset}  ${C.dim}(concurrency: ${concurrency}, format: ${settings.downloadFormat.toUpperCase()})${C.reset}\n`);
    let successCount = 0, failCount = 0;
    let index = 0;
    async function worker() {
        while (index < jobs.length) {
            const i = index++;
            const job = jobs[i];
            console.log(`  ${C.dim}[${i+1}/${jobs.length}]${C.reset} ${C.cyan}episode ${job.episode}${C.reset}`);
            try {
                const stream = await withSpinner(`fetching stream from ${job.provider.name}...`, async () => await job.provider.extractStreamFromLinkId(job.serverId));
                if (stream && selectedQuality && stream.qualityUrls && stream.qualityUrls[selectedQuality]) {
                    stream.file = stream.qualityUrls[selectedQuality];
                    console.log(`  ${C.dim}  quality: ${selectedQuality}${C.reset}`);
                }
                const ext = settings.downloadFormat;
                const filename = `${coreTitle} - Episode ${job.episode} (${job.audio.toUpperCase()}).${ext}`;
                const success = await resumeableDownload(stream, filename, null, ext);
                if (success) successCount++;
                else failCount++;
            } catch (err) {
                console.log(`  ${C.red}✗ ${err.message}${C.reset}`);
                failCount++;
            }
        }
    }
    const workers = Array(concurrency).fill().map(() => worker());
    await Promise.all(workers);
    console.log(`\n  ${C.green}✓ ${successCount} done${C.reset}  ${failCount > 0 ? `${C.red}✗ ${failCount} failed${C.reset}` : ''}`);
    await pauseForKey();
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const askQuestion = (q) => new Promise(res => rl.question(q, res));

async function askNumber(prompt, min, max) {
    while (true) {
        const raw = await askQuestion(prompt);
        const num = parseInt(raw.trim(), 10);
        if (!isNaN(num) && num >= min && num <= max) return num;
        console.log(`  ${C.red}Please enter a number between ${min} and ${max}.${C.reset}`);
    }
}

let renderScheduled = false;

async function selectMenuOption(options, title, config = {}) {
    return new Promise((resolve) => {
        if (options.length === 0) { resolve(-1); return; }
        let currentPos = 0, resolved = false;
        const pageSize = config.pageSize ?? loadSettings().pageSize;
        const pageCount = Math.max(1, Math.ceil(options.length / pageSize));
        const canUseRawMode = process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
        if (!canUseRawMode) {
            if (title) console.log(title);
            options.forEach((opt, idx) => console.log(`  ${idx + 1}. ${stripAnsi(opt)}`));
            rl.question(`choose 1-${options.length}: `, (answer) => {
                const parsed = parseInt(answer.trim(), 10);
                resolve(Number.isInteger(parsed) && parsed >= 1 && parsed <= options.length ? parsed - 1 : 0);
            });
            return;
        }
        const isRaw = process.stdin.isRaw;
        process.stdin.setRawMode(true);
        readline.emitKeypressEvents(process.stdin);
        const W = process.stdout.columns || 100;
        const safeW = Math.max(50, W);
        
        const renderMenu = () => {
            clearScreen();
            if (title) console.log(title);
            const page = Math.floor(currentPos / pageSize);
            const start = page * pageSize;
            const visibleOptions = options.slice(start, start + pageSize);
            console.log();
            visibleOptions.forEach((opt, offset) => {
                const idx = start + offset;
                const numberHint = offset < 9 ? `${C.cyan}[${offset + 1}]${C.reset}` : "    ";
                if (idx === currentPos) {
                    const raw = stripAnsi(opt);
                    const padded = raw.length < safeW - 10 ? opt + " ".repeat(safeW - 10 - raw.length) : opt;
                    console.log(`  ${C.bgGreen}${C.white}${C.bold} ▶ ${numberHint} ${padded} ${C.reset}`);
                } else {
                    console.log(`  ${C.dim}  ${numberHint}${C.reset}  ${opt}${C.reset}`);
                }
            });
            console.log();
            const footerParts = ["↑↓ navigate", "↵ select", "1-9 quick pick"];
            if (pageCount > 1) footerParts.push(`page ${page+1}/${pageCount}`);
            if (config.allowBack) footerParts.push("q back");
            console.log(`  ${C.dim}${footerParts.join("  ·  ")}${C.reset}`);
            if (config.statusBar) renderStatusBar(config.statusBar.providersCount, config.statusBar.apiUrl);
        };
        
        const scheduleRender = () => {
            if (renderScheduled) return;
            renderScheduled = true;
            setTimeout(() => { renderMenu(); renderScheduled = false; }, 10);
        };
        
        const keyHandler = (_str, key) => {
            if (resolved) return;
            if (key && key.name === '?' && !key.ctrl && !key.meta) {
                showHelp().then(() => scheduleRender());
                return;
            }
            const page = Math.floor(currentPos / pageSize);
            const pageStart = page * pageSize;
            const visibleCount = Math.min(pageSize, options.length - pageStart);
            const quickPick = key?.sequence && /^[1-9]$/.test(key.sequence) ? parseInt(key.sequence, 10) - 1 : -1;
            if (quickPick >= 0 && quickPick < visibleCount) {
                currentPos = pageStart + quickPick;
                resolved = true; cleanup(); resolve(currentPos);
            } else if (key.name === 'up') { currentPos = currentPos > 0 ? currentPos - 1 : options.length - 1; scheduleRender(); }
            else if (key.name === 'down') { currentPos = currentPos < options.length - 1 ? currentPos + 1 : 0; scheduleRender(); }
            else if (key.name === 'left' || key.name === 'pageup') { currentPos = Math.max(0, currentPos - pageSize); scheduleRender(); }
            else if (key.name === 'right' || key.name === 'pagedown') { currentPos = Math.min(options.length - 1, currentPos + pageSize); scheduleRender(); }
            else if (key.name === 'home') { currentPos = 0; scheduleRender(); }
            else if (key.name === 'end') { currentPos = options.length - 1; scheduleRender(); }
            else if (key.name === 'return') { resolved = true; cleanup(); resolve(currentPos); }
            else if (config.allowBack && (key.name === 'escape' || key.name === 'q')) { resolved = true; cleanup(); resolve(-1); }
            else if (key.ctrl && key.name === 'c') { cleanup(); process.exit(0); }
        };
        
        const cleanup = () => { process.stdin.removeListener('keypress', keyHandler); process.stdin.setRawMode(isRaw); };
        
        renderMenu();
        process.stdin.on('keypress', keyHandler);
    });
}

async function showHelp() {
    clearScreen();
    renderHeader("KITTYCLI HELP", `v${APP_VERSION}`);
    const content = [
        `${C.bold}${C.cyan}━━━ Navigation ${C.reset}`,
        `  ${C.green}↑ ↓${C.reset}        move through menu options`,
        `  ${C.green}↵${C.reset}          select highlighted item`,
        `  ${C.green}1 – 9${C.reset}      quick-pick visible row`,
        `  ${C.green}home / end${C.reset} jump to top / bottom`,
        `  ${C.green}pgup / pgdn${C.reset} change page`,
        `  ${C.green}?${C.reset}          this help screen`,
        `  ${C.green}q${C.reset}          back to previous menu`,
        ``,
        `${C.bold}${C.cyan}━━━ Binge Mode ${C.reset}`,
        `  ${C.green}Y${C.reset}          continue to next episode now`,
        `  ${C.green}N${C.reset}          stop binge`,
        `  ${C.green}A${C.reset}          toggle audio (sub/dub)`,
        ``,
        `${C.bold}${C.cyan}━━━ Premium Features ${C.reset}`,
        `  ${C.green}🎬 Multi-provider${C.reset}  search across 15+ sources in parallel`,
        `  ${C.green}📝 Smart Watchlist${C.reset}  with progress, seasons & tracking`,
        `  ${C.green}⬇️  Download System${C.reset}   ${C.bold}MKV${C.reset}${C.dim}/${C.reset}${C.bold}MP4${C.reset} with quality selection`,
        `  ${C.green}🔄 Resumable${C.reset}      downloads & playback position sync`,
        `  ${C.green}⚡ Batch${C.reset}         download multiple episodes`,
        `  ${C.green}🎨 AniList${C.reset}       real episode titles & seasons`,
        `  ${C.green}💬 Discord${C.reset}       Rich Presence support`,
        `  ${C.green}🎛️  Playback${C.reset}      quality selection on stream`,
        ``,
        `${C.bold}${C.cyan}━━━ Settings Available ${C.reset}`,
        `  ◈ Download format & quality preferences`,
        `  ◈ Auto-play, resume, quality defaults`,
        `  ◈ Binge delay, playback speed`,
        `  ◈ Provider matching & retry policies`,
        ``,
        `${C.bold}${C.cyan}━━━ Learn More ${C.reset}`,
        `  ${C.underline}${C.yellow}${GITHUB_URL}${C.reset}`,
        ``,
        `${C.dim}${C.bold}✦${C.reset}${C.dim} Press any key to return${C.reset}`
    ];
    renderBox(`${C.cyan}?${C.reset} ${t('boxes.help')}`, content, C.cyan);
    await pauseForKey();
}

async function bingeCountdownWithProgress(seconds, nextEpisodeNum, currentAudio, nextEpisodeTitle, onAudioToggle, autoPlayNext) {
    if (autoPlayNext) return { continue: true };
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
        const titleText = nextEpisodeTitle ? ` • ${C.dim}${nextEpisodeTitle.substring(0, 50)}${C.reset}` : '';
        console.log(`\n  ${C.yellow}${C.bold}▶${C.reset} Next: Episode ${C.bold}${nextEpisodeNum}${C.reset}${titleText}`);
        console.log(`  ${C.yellow}${C.bold}⏱${C.reset} Starting in ${C.bold}${seconds}s${C.reset}...`);
        await wait(seconds * 1000);
        return { continue: true };
    }
    return new Promise((resolve) => {
        let remaining = seconds, resolved = false;
        const isRaw = process.stdin.isRaw;
        process.stdin.setRawMode(true);
        let audio = currentAudio;
        const render = () => {
            const filled = Math.min(20, Math.max(0, Math.round((remaining / seconds) * 20)));
            const bar = `${C.green}${'▮'.repeat(filled)}${C.reset}${C.dim}${'─'.repeat(Math.max(0, 20 - filled))}${C.reset}`;
            const audioTag = audio === "sub" ? `${C.cyan}◈ SUB${C.reset}` : `${C.magenta}◈ DUB${C.reset}`;
            const epStr = String(nextEpisodeNum).padStart(2, '0');
            const titleDisplay = nextEpisodeTitle ? ` ${C.dim}•${C.reset} ${C.yellow}${nextEpisodeTitle.substring(0, 35)}${C.reset}` : "";
            const timeColor = remaining <= 3 ? C.red : remaining <= 5 ? C.yellow : C.green;
            process.stdout.write(`\x1b[2K\r  ${C.bold}${C.green}▶${C.reset} E${C.cyan}${epStr}${C.reset}${titleDisplay}  [${bar}] ${C.bold}${timeColor}${remaining}s${C.reset}  ${C.dim}│${C.reset} ${C.green}${C.bold}Y${C.reset}${C.dim} now  ${C.reset}${C.green}${C.bold}N${C.reset}${C.dim} stop  ${C.reset}${C.green}${C.bold}A${C.reset}${C.dim} audio${C.reset} [${audioTag}]`);
        };
        const timer = setInterval(() => {
            if (resolved) return;
            remaining--;
            if (remaining <= 0) {
                clearInterval(timer);
                if (!resolved) {
                    resolved = true;
                    process.stdin.setRawMode(isRaw);
                    process.stdin.removeListener('data', onData);
                    console.log();
                    resolve({ continue: true, newAudio: audio !== currentAudio ? audio : undefined });
                }
            } else render();
        }, 1000);
        const onData = (chunk) => {
            const key = chunk.toString().toLowerCase();
            if (key === 'y' || key === '\r') {
                if (!resolved) { resolved = true; clearInterval(timer); process.stdin.setRawMode(isRaw); process.stdin.removeListener('data', onData); console.log(); resolve({ continue: true, newAudio: audio !== currentAudio ? audio : undefined }); }
            } else if (key === 'n') {
                if (!resolved) { resolved = true; clearInterval(timer); process.stdin.setRawMode(isRaw); process.stdin.removeListener('data', onData); console.log(`\n  ${C.yellow}⏹${C.reset} Binge stopped.`); resolve({ continue: false }); }
            } else if (key === 'a') {
                audio = audio === "sub" ? "dub" : "sub";
                if (onAudioToggle) onAudioToggle();
                render();
            }
        };
        render();
        process.stdin.on('data', onData);
    });
}

async function checkApiServer(baseUrl) {
    try {
        await axios.get(`${baseUrl}/health`, { timeout: 4000 });
        return true;
    } catch (err) {
        debugLog(`API health check failed: ${err.message}`);
        renderBox(`${C.red}✗${C.reset} ${t('boxes.connectionError')}`, [`${C.red}Cannot reach${C.reset} ${C.bold}${baseUrl}${C.reset}`, `${C.dim}Check the server is running and the URL is correct.${C.reset}`, ``, `${C.dim}You can change the API URL in ${C.bold}settings${C.reset}${C.dim}.${C.reset}`], C.red);
        return false;
    }
}

class ApiProvider {
    constructor(baseUrl, name) {
        this.baseUrl = baseUrl;
        this.name = name;
    }

    async search(query, dub = false) {
        try {
            const response = await axios.post(`${this.baseUrl}/api/v2/provider/${this.name}/query`, {
                operation: "search",
                query: { title: query, dub }
            }, { timeout: 15000 });
            return response.data;
        } catch (err) {
            debugLog(`API error for ${this.name}.search:`, err.message);
            return [];
        }
    }

    async findEpisodes(seriesUrl, anilistId) {
        try {
            const response = await axios.post(`${this.baseUrl}/api/v2/provider/${this.name}/query`, {
                operation: "episodes",
                query: { anilistId: anilistId || seriesUrl }
            }, { timeout: this.name === 'AniDB' ? 20000 : 15000 });
            let data = response.data;
            if (data && typeof data === 'object') {
                if (Array.isArray(data)) return data;
                const arrayKeys = ['episodes', 'data', 'results', 'list', 'items', 'episodeList', 'episode_list', 'eps', 'content', 'records', 'payload'];
                for (const key of arrayKeys) {
                    if (data[key] && Array.isArray(data[key]) && data[key].length > 0) return data[key];
                }
                for (const val of Object.values(data)) {
                    if (Array.isArray(val) && val.length > 0) return val;
                }
            }
            return [];
        } catch (err) {
            debugLog(`API error for ${this.name}.findEpisodes:`, err.message);
            return [];
        }
    }

    async findAvailableServers(anilistId, episode = 1, audio = 'sub') {
        try {
            const response = await axios.post(`${this.baseUrl}/api/v2/provider/${this.name}/query`, {
                operation: "servers",
                query: { anilistId, episode, audio }
            }, { timeout: this.name === 'AniDB' ? 20000 : 15000 });
            return response.data || [];
        } catch (err) {
            debugLog(`API error for ${this.name}.findAvailableServers:`, err.message);
            return [];
        }
    }

    async extractStreamFromLinkId(linkId) {
        try {
            const response = await axios.get(`${this.baseUrl}/provider/${this.name}/stream`, {
                params: { linkId },
                timeout: this.name === 'AniDB' ? 60000 : 30000
            });
            const stream = response.data;
            if (stream && !stream.file && stream.url) stream.file = stream.url;
            if (stream.tracks && Array.isArray(stream.tracks)) {
                for (const track of stream.tracks) {
                    if (!track.file && track.url) track.file = track.url;
                }
            }
            if (stream.qualities && Array.isArray(stream.qualities) && stream.qualities.length > 0) {
                stream.qualities = stream.qualities.map(q => typeof q === 'string' ? q : q.label || q.quality || 'unknown');
            }
            return stream;
        } catch (err) {
            debugLog(`API error for ${this.name}.extractStreamFromLinkId:`, err.message);
            throw new Error(`Failed to extract stream: ${err.message}`);
        }
    }

    async mapAnilistId(anilistId) {
        try {
            const response = await axios.get(`${this.baseUrl}/provider/${this.name}/map`, {
                params: { anilistId: String(anilistId) },
                timeout: 8000
            });
            return response.data;
        } catch (err) {
            debugLog(`API error for ${this.name}.mapAnilistId:`, err.message);
            return null;
        }
    }

    async extractStreamDirectByAnilistId(anilistId, episodeNumber, audio = 'sub') {
        try {
            // Check cache first (30 minute TTL)
            const cacheKey = `streamDirect:${this.name}:${anilistId}:${episodeNumber}:${audio}`;
            const now = Date.now();
            const cached = streamDirectCache.get(cacheKey);
            if (cached && (now - cached.timestamp) < 1800000) { // 30 minutes
                debugLog(`Cache hit for ${cacheKey}`);
                return cached.data;
            }

            const response = await axios.post(`${this.baseUrl}/api/v2/provider/${this.name}/stream`, {
                type: "direct",
                query: { anilistId: Number(anilistId), episode: episodeNumber, audio }
            }, { timeout: 10000 });
            const stream = response.data;

            // Ensure file URL is properly set
            if (stream && !stream.file && stream.url) stream.file = stream.url;

            // Process headers if present
            if (stream.headers && typeof stream.headers === 'object') {
                // Ensure headers are available for playback
                if (!stream.headers.Referer && !stream.referer && stream.file) {
                    stream.headers.Referer = stream.file;
                }
            }

            // Process subtitle tracks
            if (stream.tracks && Array.isArray(stream.tracks)) {
                for (const track of stream.tracks) {
                    if (!track.file && track.url) track.file = track.url;
                    // Ensure track has label
                    if (!track.label && track.lang) track.label = track.lang;
                    // Ensure srclang for subtitle tracks
                    if (!track.srclang && track.label) {
                        const langMap = { english: 'en', spanish: 'es', french: 'fr', japanese: 'ja', german: 'de' };
                        track.srclang = langMap[track.label.toLowerCase()] || 'en';
                    }
                }
            }

            // Process allServers array if present
            if (stream.allServers && Array.isArray(stream.allServers)) {
                for (const server of stream.allServers) {
                    // Ensure each server has a file URL
                    if (!server.file && server.url) server.file = server.url;
                    // Ensure quality label is present
                    if (!server.quality && server.label) server.quality = server.label;
                    // Ensure headers are present for each server
                    if (!server.headers && stream.headers) {
                        server.headers = { ...stream.headers };
                    }
                }
            }

            // Store in cache
            streamDirectCache.set(cacheKey, { data: stream, timestamp: now });
            // Clean cache if it gets too large
            cleanCache(streamDirectCache, 50, 1800000);

            return stream;
        } catch (err) {
            debugLog(`API error for ${this.name}.extractStreamDirectByAnilistId:`, err.message);
            return null;
        }
    }
}

async function fetchProviderList(apiBaseUrl) {
    try {
        const response = await axios.get(`${apiBaseUrl}/api/v2/providers/status`, { timeout: 5000 });
        const providers = response.data.providers || [];
        return providers.filter(p => p.online).map(p => p.name);
    } catch (err) {
        debugLog("Failed to fetch provider list from API, using fallback list.");
        return [
            "Miruro", "anitaku", "MKissa",  "AniZone", "Anikoto",
            "AnimeGG", "AllAnime", "Nyanime", "AniDao",
            "Animeverse", "AnimeHeaven", "AniNeko", "AnimeParadise", "KaaLt", "AniDB", "Anineko"
        ];
    }
}

async function createProviders(apiBaseUrl) {
    const providerNames = await fetchProviderList(apiBaseUrl);
    return providerNames.map(name => new ApiProvider(apiBaseUrl, name));
}

function filterEnabledProviders(providers, settings) {
    if (!settings.enabledProviders || settings.enabledProviders.length === 0) return providers;
    return providers.filter(p => settings.enabledProviders.includes(p.name));
}

async function selectServerTwoStep(providerServersMap, audioLabelText, statusBar) {
    if (providerServersMap.size === 0) return null;
    const providerEntries = Array.from(providerServersMap.entries());
    const providerOptions = providerEntries.map(([prov, servers]) => `${C.bold}${prov.name}${C.reset}  ${C.dim}${servers.length} ${servers.length !== 1 ? t('labels.servers') : t('labels.server')}${C.reset}`);
    const providerIdx = await selectMenuOption(providerOptions, `\n  ${C.bold}${C.cyan}◈ ${t('menus.selectSource')}${C.reset}  ${C.dim}(${audioLabelText})${C.reset}`, { allowBack: true, statusBar });
    if (providerIdx < 0) return null;
    const [selectedProvider, servers] = providerEntries[providerIdx];
    const serverOptions = servers.map(s => s.name);
    const serverIdx = await selectMenuOption(serverOptions, `\n  ${C.bold}${C.cyan}◈ ${selectedProvider.name}${C.reset}  ${C.dim}${t('menus.selectServer')}${C.reset}`, { allowBack: true, statusBar });
    if (serverIdx < 0) return null;
    return { provider: selectedProvider, serverId: servers[serverIdx].id, serverName: servers[serverIdx].name };
}

async function selectEpisodeSimple(maxEpNum, totalEpisodes, _, statusBar) {
    const episodeOptions = [];
    for (let i = 1; i <= maxEpNum; i++) {
        const denominator = totalEpisodes ? `${C.dim}/${totalEpisodes}${C.reset}` : `${C.dim}/?${C.reset}`;
        const episodeNum = `${C.cyan}E${String(i).padStart(2, '0')}${C.reset}`;
        const icon = i === 1 ? `${C.green}●${C.reset}` : ` `;
        const label = `${icon} ${episodeNum}${denominator}${C.dim}  ─ ${t('episodes.episode')} ${i}${C.reset}`;
        episodeOptions.push(label);
    }

    const headerText = `\n  ${C.bold}${C.cyan}▶ ${t('episodes.select')}${C.reset}  ${C.bold}${maxEpNum}${C.reset}${C.dim} episodes available${C.reset}`;
    const pickedEpIdx = await selectMenuOption(episodeOptions, headerText, { allowBack: true, statusBar });
    return pickedEpIdx >= 0 ? pickedEpIdx + 1 : -1;
}

async function batchDownloadQueueStreamDirect(jobs, coreTitle, statusBar, selectedQuality = null, audio = 'sub') {
    if (jobs.length === 0) { renderBox(t('app.error'), [t('download.downloadFailed')], C.red); return; }

    const settings = loadSettings();
    const ext = settings.downloadFormat;

    renderBox(`${C.magenta}⬇⬇${C.reset} ${t('download.batchDownload')}`, [
        `${C.bold}${C.green}${jobs.length}${C.reset} ${t('labels.episodes')} ${C.dim}queued for download${C.reset}`,
        `${C.blue}📦${C.reset} ${C.dim}Format:${C.reset} ${C.bold}${ext.toUpperCase()}${C.reset}`,
        `${C.yellow}⚙${C.reset} ${C.dim}Quality:${C.reset} ${C.bold}${selectedQuality || 'auto'}${C.reset}`,
    ], C.cyan);

    let successCount = 0, failCount = 0;
    for (const job of jobs) {
        const filename = `${coreTitle} - Episode ${job.episode} (${audio.toUpperCase()}).${ext}`;
        try {
            const progress = `[${C.cyan}${successCount + failCount + 1}${C.reset}/${C.cyan}${jobs.length}${C.reset}]`;
            console.log(`\n  ${C.bold}${progress}${C.reset} ${C.green}⬇${C.reset} ${t('download.downloading')} ${C.bold}${filename}${C.reset}...`);
            const stream = await withSpinner(`Fetching stream...`, async () => await job.provider.extractStreamDirectByAnilistId(job.anilistId, job.episode, audio));

            if (!stream || !stream.file) {
                console.log(`  ${C.red}✗${C.reset} Failed to fetch stream`);
                failCount++;
                continue;
            }

            // Display stream metadata
            if (stream.provider) console.log(`  ${C.dim}Provider:${C.reset} ${C.bold}${stream.provider}${C.reset}`);
            if (stream.server) console.log(`  ${C.dim}Server:${C.reset} ${C.bold}${stream.server}${C.reset}`);
            if (stream.cached !== undefined) console.log(`  ${C.dim}Status:${C.reset} ${stream.cached ? `${C.green}cached${C.reset}` : `${C.yellow}live${C.reset}`}`);

            // Handle quality selection from response
            if (selectedQuality && stream.qualityUrls && stream.qualityUrls[selectedQuality]) {
                stream.file = stream.qualityUrls[selectedQuality];
                console.log(`  ${C.dim}Quality:${C.reset} ${C.bold}${selectedQuality}${C.reset}`);
            }

            // Handle server selection if multiple available
            if (stream.allServers && stream.allServers.length > 1) {
                // Use first server or preferred quality server
                const selectedServer = selectedQuality
                    ? stream.allServers.find(s => s.quality?.includes(selectedQuality)) || stream.allServers[0]
                    : stream.allServers[0];
                if (selectedServer && selectedServer.file) {
                    stream.file = selectedServer.file;
                    if (selectedServer.headers) {
                        stream.headers = { ...stream.headers, ...selectedServer.headers };
                    }
                    console.log(`  ${C.dim}Using server:${C.reset} ${C.bold}${selectedServer.quality || 'default'}${C.reset}`);
                }
            }

            await resumeableDownload(stream, filename, null, ext);
            console.log(`  ${C.green}✓${C.reset} Episode ${C.bold}${job.episode}${C.reset} downloaded successfully`);
            successCount++;
        } catch (err) {
            console.log(`  ${C.red}✗${C.reset} ${t('download.downloadFailed')}: ${err.message.substring(0, 50)}`);
            failCount++;
        }
    }

    const successRate = Math.round((successCount / jobs.length) * 100);
    const summaryColor = successCount === jobs.length ? C.green : successRate >= 75 ? C.yellow : C.red;
    renderBox(`${C.magenta}⬇${C.reset} ${t('download.title')}`, [
        `${C.green}✓${C.reset} ${C.bold}${successCount}${C.reset}${C.dim} successful${C.reset}  ${C.red}✗${C.reset} ${C.bold}${failCount}${C.reset}${C.dim} failed${C.reset}`,
        `${C.dim}Progress:${C.reset} ${C.bold}${successCount}${C.reset}${C.dim}/${C.bold}${jobs.length}${C.reset}${C.dim} (${successRate}%)${C.reset}`
    ], summaryColor);
    await wait(2000);
}

// FIXED: Safe episode selection with bounds checking for progress bar
async function selectEpisodeWithMarkers(maxEpNum, totalEpisodes, title, statusBar, titleMap = new Map(), seasonInfo = null) {
    const watchInfo = getWatchlistInfo(title);
    const lastWatched = watchInfo ? watchInfo.lastEpisode : 0;
    const effectiveTotal = totalEpisodes || watchInfo?.totalEpisodes || null;
    const episodeOptions = [];
    for (let i = 1; i <= maxEpNum; i++) {
        let denominator = effectiveTotal ? `${C.dim}/${C.bold}${effectiveTotal}${C.reset}` : `${C.dim}/?${C.reset}`;
        let episodeIcon = i <= lastWatched ? `${C.green}✓${C.reset}` : i === lastWatched + 1 ? `${C.yellow}●${C.reset}` : ` `;
        let episodeNum = `${episodeIcon} ${C.cyan}E${String(i).padStart(2, '0')}${C.reset}`;
        let label = `${episodeNum}${denominator}`;

        if (effectiveTotal && effectiveTotal > 0) {
            const percent = Math.min(100, Math.max(0, Math.round((i / effectiveTotal) * 100)));
            const filled = Math.min(8, Math.max(0, Math.round(percent / 12.5)));
            const minibar = `${C.green}${'▮'.repeat(filled)}${C.reset}${C.dim}${'─'.repeat(Math.max(0, 8 - filled))}${C.reset}`;
            label += `  [${minibar}] ${C.dim}${percent.toString().padStart(3)}%${C.reset}`;
        }

        const epTitle = titleMap.get(i);
        if (epTitle && epTitle.trim()) {
            const maxTitleLen = 42;
            let displayTitle = epTitle;
            if (displayTitle.length > maxTitleLen) {
                displayTitle = displayTitle.slice(0, maxTitleLen - 1) + '…';
            }
            label += `  ${C.yellow}✦ ${displayTitle}${C.reset}`;
        }

        let marker = "";
        if (i <= lastWatched) marker = `${C.green}✓${C.reset}`;
        else if (i === lastWatched + 1) marker = `${C.yellow}▶${C.reset}`;
        else marker = `${C.dim}·${C.reset}`;

        episodeOptions.push(`${marker}  ${label}`);
    }

    let headerText = `\n  ${C.bold}${C.cyan}◈ ${t('boxes.episodeSelect')}${C.reset}  ${C.dim}${maxEpNum} ${t('labels.episodes')}${C.reset}`;
    if (seasonInfo && (seasonInfo.season || seasonInfo.seasonYear)) {
        const seasonDisplay = [];
        if (seasonInfo.season) {
            const seasonMap = { winter: '❄️ Winter', spring: '🌸 Spring', summer: '☀️ Summer', fall: '🍂 Fall' };
            const seasonName = seasonMap[seasonInfo.season.toLowerCase()] || seasonInfo.season;
            seasonDisplay.push(`${C.cyan}${seasonName}${C.reset}`);
        }
        if (seasonInfo.seasonYear) seasonDisplay.push(`${C.bold}${seasonInfo.seasonYear}${C.reset}`);
        headerText += `  ${C.dim}•${C.reset}  ${seasonDisplay.join(' ')}`;
    }
    const pickedEpIdx = await selectMenuOption(episodeOptions, headerText, { allowBack: true, statusBar });
    return pickedEpIdx >= 0 ? pickedEpIdx + 1 : -1;
}

async function showMetadataPanel(title) {
    console.log(`\n  ${C.dim}Fetching metadata for${C.reset} ${C.bold}"${title}"${C.reset}...`);
    const metadata = await fetchAnimeMetadata(title);
    if (metadata) {
        const content = [];

        const seasonMapEmoji = { winter: '❄️', spring: '🌸', summer: '☀️', fall: '🍂' };
        const seasonEmoji = metadata.season ? seasonMapEmoji[metadata.season.toLowerCase()] || '📺' : '📺';

        if (metadata.rating) {
            const filled = Math.min(5, Math.max(0, Math.round(metadata.rating / 2)));
            const stars = `${C.yellow}${'★'.repeat(filled)}${C.reset}${C.dim}${'☆'.repeat(Math.max(0, 5 - filled))}${C.reset}`;
            content.push(`${stars}  ${C.bold}${metadata.rating}${C.reset}${C.dim}/10${C.reset}`);
            content.push('');
        }

        const seasonInfo = [];
        if (metadata.season) seasonInfo.push(`${seasonEmoji} ${C.cyan}${metadata.season.charAt(0).toUpperCase() + metadata.season.slice(1)}${C.reset}`);
        if (metadata.seasonYear) seasonInfo.push(`${C.bold}${metadata.seasonYear}${C.reset}`);
        if (seasonInfo.length > 0) content.push(`${C.dim}Season${C.reset}   ${seasonInfo.join(' ')}`);

        if (metadata.genres && metadata.genres.length) {
            const genreStr = metadata.genres.slice(0, 6).map(g => `${C.cyan}${g}${C.reset}`).join(`  ${C.dim}•${C.reset}  `);
            content.push(`${C.dim}Genres${C.reset}   ${genreStr}`);
        }

        const epStatusLine = [];
        if (metadata.episodes) epStatusLine.push(`${C.bold}${metadata.episodes}${C.reset} episodes`);
        if (metadata.status) epStatusLine.push(`${C.yellow}${metadata.status}${C.reset}`);
        if (epStatusLine.length > 0) content.push(`${C.dim}Info${C.reset}     ${epStatusLine.join(`  ${C.dim}•${C.reset}  `)}`);

        if (metadata.synopsis) {
            content.push('');
            const cleanSynopsis = stripHtmlTags(metadata.synopsis);
            const words = cleanSynopsis.split(' ');
            let line = '';
            for (const word of words) {
                if ((line + ' ' + word).length <= 70) line += (line ? ' ' : '') + word;
                else { content.push(`  ${C.dim}${line}${C.reset}`); line = word; }
            }
            if (line) content.push(`  ${C.dim}${line}${C.reset}`);
        }
        renderBox(`${seasonEmoji} ${title}`, content, C.green);
    } else {
        renderBox(t('app.info'), [`${t('labels.noMetadata')} "${title}".`], C.dim);
    }
    console.log(`\n  ${C.dim}1 ${t('labels.continue')}  2 ${t('labels.back')}${C.reset}`);
    const answer = await askQuestion(`\n  ${C.bold}${C.yellow}›${C.reset} `);
    return answer.trim() === '1' ? metadata : null;
}

async function triggerSearchWorkflow(initialQuery, providersList) {
    if (!providersList) providersList = await createProviders(loadSettings().apiBaseUrl);
    const settings = loadSettings();
    providersList = filterEnabledProviders(providersList, settings);
    if (providersList.length === 0) {
        renderBox(t('app.warning'), ["No providers are enabled. Please enable at least one provider in Settings → Manage Providers."], C.yellow);
        await pauseForKey();
        return;
    }
    clearScreen();
    renderHeader(t('search.title'), `${providersList.length} providers ready`);
    const query = initialQuery ?? await askQuestion(`\n  ${C.bold}${C.yellow}${t('search.prompt')}${C.reset} `);
    const payload = query.trim();
    if (!payload) return;
    saveSearchToHistory(payload);

    let globalResults;
    const cacheKey = `search:${payload}:${settings.defaultAudio}`;
    cleanCache(searchCache, settings.cacheMaxSize, settings.cacheTTL);
    if (searchCache.has(cacheKey) && (Date.now() - searchCache.get(cacheKey).timestamp) < settings.cacheTTL) {
        globalResults = searchCache.get(cacheKey).data;
        console.log(`  ${C.dim}Using cached results${C.reset}`);
    } else {
        globalResults = await withSpinner(t('search.searching', { count: providersList.length }), async () => {
            const results = await Promise.all(providersList.map(async (prov) => {
                try { const hits = await prov.search(payload, settings.defaultAudio === 'dub'); return Array.isArray(hits) ? hits.map(item => ({ provider: prov, item })) : []; } catch(e) { return []; }
            }));
            return results.flat();
        });
        searchCache.set(cacheKey, { data: globalResults, timestamp: Date.now() });
    }

    let flattenedMatches = globalResults.map(match => ({ ...match, score: 0 }));
    if (!flattenedMatches.length) { renderBox(t('app.error'), [t('search.noResults', { query: payload })], C.red); await wait(1500); return; }

    const normalizedQuery = payload.toLowerCase();
    flattenedMatches = flattenedMatches.map(match => {
        let cleanTitle = match.item.title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim();
        match.item.title = cleanTitle;
        const similarity = similarityScore(cleanTitle, normalizedQuery);
        let score = Math.floor(similarity * 100);
        if (cleanTitle.toLowerCase() === normalizedQuery) score = 100;
        return { ...match, score };
    }).filter(match => match.score > settings.minSimilarityScore);

    if (!flattenedMatches.length) { renderBox(t('app.warning'), [t('search.noCloseMatches')], C.red); await wait(1500); return; }

    const groupedMap = {};
    flattenedMatches.forEach(match => { const normalizedKey = match.item.title.toLowerCase(); if (!groupedMap[normalizedKey]) groupedMap[normalizedKey] = []; groupedMap[normalizedKey].push(match); });
    const groupEntries = Object.entries(groupedMap).map(([key, matches]) => ({ key, matches, maxScore: Math.max(...matches.map(m => m.score)) }));
    groupEntries.sort((a, b) => b.maxScore - a.maxScore);
    const topGroups = groupEntries.slice(0, 50);

    const showSelectionStrings = topGroups.map(({ key, matches }) => {
        const item = matches[0].item;
        const uniqueEngines = Array.from(new Set(matches.map(i => i.provider.name)));
        const audioFlags = audioLabel(matches.some(i => i.item.hasSub), matches.some(i => i.item.hasDub));
        const sourceLabel = uniqueEngines.length === 1 ? `${C.cyan}${uniqueEngines[0]}${C.reset}` : `${C.cyan}${uniqueEngines.length}${C.reset}${C.dim} sources${C.reset}`;
        const score = Math.max(...matches.map(m => m.score));
        let scoreBar = '';
        if (score >= 95) scoreBar = `${C.green}${C.bold}⭐${C.reset} ${score}%`;
        else if (score >= 90) scoreBar = `${C.green}${score}%${C.reset}`;
        else if (score >= 70) scoreBar = `${C.yellow}${score}%${C.reset}`;
        else scoreBar = `${C.dim}${score}%${C.reset}`;
        return `${padRightVisible(item.title, 40)} ${C.cyan}◈${C.reset} ${audioFlags}${" ".repeat(3)}${sourceLabel}${" ".repeat(2)}${scoreBar}`;
    });

    const idx = await selectMenuOption(showSelectionStrings, `\n  ${C.bold}${C.cyan}◈ ${t('search.results')}${C.reset} ${C.bold}"${payload}"${C.reset}`, { allowBack: true, statusBar: { providersCount: providersList.length, apiUrl: loadSettings().apiBaseUrl } });
    if (idx >= 0 && idx < topGroups.length) {
        const selectedGroup = topGroups[idx];
        const selectedTitle = selectedGroup.matches[0].item.title;
        const showMeta = await selectMenuOption([t('search.viewDetails'), t('search.goToEpisodes')], `\n  ${C.bold}${C.cyan}◈ ${selectedTitle}${C.reset}`, { allowBack: true });
        if (showMeta === 0) { const metadata = await showMetadataPanel(selectedTitle); if (!metadata) return; }
        else if (showMeta < 0) return;
        // Pass the entire group and title to new stream-direct flow
        await handleAnimeSelectionStreamDirect(selectedGroup.matches, selectedTitle);
    }
}

async function handleAnimeSelectionStreamDirect(selectedMatches, animeTitle) {
    const settings = loadSettings();
    let providersList = await createProviders(settings.apiBaseUrl);
    providersList = filterEnabledProviders(providersList, settings);
    const statusBar = { providersCount: providersList.length, apiUrl: settings.apiBaseUrl };
    const hasSub = selectedMatches.some(m => m.item.hasSub);
    const hasDub = selectedMatches.some(m => m.item.hasDub);
    let audio = settings.defaultAudio;

    if (hasSub && hasDub) {
        const audioIdx = await selectMenuOption([`${C.cyan}◈ ${t('audio.sub')}${C.reset}  ${C.bold}${t('audio.subtitled')}${C.reset}${C.dim} - English subtitles${C.reset}`, `${C.magenta}◈ ${t('audio.dub')}${C.reset}  ${C.bold}${t('audio.dubbed')}${C.reset}${C.dim} - Dubbed audio${C.reset}`], `\n  ${C.bold}${C.cyan}◈ ${t('audio.selectAudio')}${C.reset}`, { allowBack: true, statusBar });
        if (audioIdx === 1) audio = "dub";
        else if (audioIdx < 0) return;
    } else if (!hasSub && hasDub) audio = "dub";
    else if (hasSub && !hasDub) audio = "sub";

    let isDownloadMode = false, isBatchMode = false;
    const actionOptions = [
        `${C.green}▶${C.reset}  ${C.bold}${t('actions.streamOnline')}${C.reset}${C.dim}  ─ Fast & immediate playback${C.reset}`,
        `${C.cyan}⬇${C.reset}  ${C.bold}${t('actions.downloadSingleEpisode')}${C.reset}${C.dim}  ─ Save for offline${C.reset}`,
        `${C.magenta}⬇⬇${C.reset} ${C.bold}${t('actions.batchDownload')}${C.reset} ${C.dim}(${C.bold}MKV${C.dim})  ─ Download all episodes${C.reset}`
    ];
    const actionIdx = await selectMenuOption(actionOptions, `\n  ${C.bold}${C.cyan}◈ ${t('menus.whatWouldYouLikeToDo')}${C.reset}`, { allowBack: true, statusBar });
    if (actionIdx < 0) return;
    switch (actionIdx) {
        case 0: isDownloadMode = false; break;
        case 1: isDownloadMode = true; break;
        case 2: isDownloadMode = true; isBatchMode = true; break;
    }

    // Fetch AniList ID for the anime title
    let anilistId = null;
    console.log(`\n  ${C.dim}Fetching anime metadata...${C.reset}`);
    const metadata = await fetchAnimeMetadata(animeTitle);
    if (metadata && metadata.anilistId) {
        anilistId = metadata.anilistId;
        debugLog(`Resolved AniList ID: ${anilistId}`);
    }

    if (!anilistId) {
        renderBox(t('app.error'), [t('boxes.couldNotResolveAnilist')], C.yellow);
        await wait(2000);
        // Fall back to traditional flow
        await handleAnimeSelection(selectedMatches);
        return;
    }

    // Fetch episode count from AniList
    let maxEpNum = 1;
    let effectiveTotalEpisodes = null;
    try {
        const episodeData = await fetchAnilistEpisodes(anilistId);
        if (episodeData && episodeData.episodes) {
            maxEpNum = episodeData.episodes;
            effectiveTotalEpisodes = episodeData.episodes;
        }
    } catch(e) {
        debugLog(`Failed to fetch episode count: ${e.message}`);
    }

    // Simple episode selection
    let targetEpisode = 1;
    if (!isBatchMode) {
        const picked = await selectEpisodeSimple(maxEpNum, effectiveTotalEpisodes, animeTitle, statusBar);
        if (picked === -1) return;
        targetEpisode = picked;
    }

    if (isDownloadMode && isBatchMode) {
        const start = await askNumber(`\n  ${C.yellow}${t('labels.startEpisode')} (1–${maxEpNum})${C.reset}  ${C.bold}›${C.reset} `, 1, maxEpNum);
        const end = await askNumber(`  ${C.yellow}${t('labels.endEpisode')} (${start}–${maxEpNum})${C.reset}  ${C.bold}›${C.reset} `, start, maxEpNum);

        // For batch, fetch from all providers to show combined selector
        let selectedProvider = null;
        let selectedQuality = null;
        const allProviderStreams = await withSpinner(`Fetching stream info from ${selectedMatches.length} provider${selectedMatches.length !== 1 ? 's' : ''}...`, async () => {
            // Fetch from all providers in parallel for faster results
            const streams = await Promise.all(selectedMatches.map(match =>
                match.provider.extractStreamDirectByAnilistId(anilistId, start, audio).catch(e => {
                    debugLog(`Failed to fetch from ${match.provider.name}: ${e.message}`);
                    return null;
                })
            ));

            return selectedMatches
                .map((match, i) => ({ provider: match.provider, stream: streams[i] }))
                .filter(x => x.stream && (x.stream.file || x.stream));
        });

        if (allProviderStreams.length > 1) {
            const providerOptions = allProviderStreams.map(({ provider, stream }) => {
                const file = stream.file || stream.url || '';
                const qualityStr = stream.quality || (stream.qualities && stream.qualities.length > 0 ? stream.qualities[0] : 'Default');
                const serversInfo = stream.allServers ? ` (${stream.allServers.length} servers)` : '';
                return `${provider.name} • ${qualityStr} • ${file.includes('.m3u8') ? 'HLS' : 'MP4'}${serversInfo}`;
            });
            const providerIdx = await selectMenuOption(providerOptions, `\n  ${C.bold}${C.cyan}◈ ${t('streaming.selectProvider')}${C.reset}`, { allowBack: true, statusBar });
            if (providerIdx >= 0) {
                selectedProvider = allProviderStreams[providerIdx].provider;
                const sampleStream = allProviderStreams[providerIdx].stream;
                if (sampleStream && sampleStream.qualities && sampleStream.qualities.length > 1) {
                    const qualityOptions = sampleStream.qualities.map(q => `${q}`);
                    const qualityIdx = await selectMenuOption(qualityOptions, `\n  ${C.bold}${C.cyan}◈ ${t('streaming.selectQuality')}${C.reset}`, { allowBack: true, statusBar });
                    if (qualityIdx >= 0) selectedQuality = sampleStream.qualities[qualityIdx];
                }
            } else return;
        } else if (allProviderStreams.length === 1) {
            selectedProvider = allProviderStreams[0].provider;
            const sampleStream = allProviderStreams[0].stream;
            if (sampleStream && sampleStream.allServers && sampleStream.allServers.length > 1) {
                const serverOptions = sampleStream.allServers.map((s, i) => `${s.quality || `Server ${i+1}`} • ${s.file ? (s.file.includes('.m3u8') ? 'HLS' : 'MP4') : 'Unknown'}`);
                const serverIdx = await selectMenuOption(serverOptions, `\n  ${C.bold}${C.cyan}◈ ${t('streaming.selectProvider')}${C.reset}`, { allowBack: true, statusBar });
                if (serverIdx >= 0) selectedQuality = sampleStream.allServers[serverIdx].quality;
            } else if (sampleStream && sampleStream.qualities && sampleStream.qualities.length > 1) {
                const qualityOptions = sampleStream.qualities.map(q => `${q}`);
                const qualityIdx = await selectMenuOption(qualityOptions, `\n  ${C.bold}${C.cyan}◈ ${t('streaming.selectQuality')}${C.reset}`, { allowBack: true, statusBar });
                if (qualityIdx >= 0) selectedQuality = sampleStream.qualities[qualityIdx];
            }
        } else {
            renderBox(t('app.error'), [t('streaming.noStreamAvailable', { episode: 'batch' })], C.red);
            return;
        }

        const jobs = [];
        for (let ep = start; ep <= end; ep++) {
            jobs.push({ episode: ep, title: `Episode ${ep}`, provider: selectedProvider, anilistId, audio });
        }
        await batchDownloadQueueStreamDirect(jobs, animeTitle, statusBar, selectedQuality, audio);
        return;
    }

    if (isDownloadMode) {
        // Single episode download - fetch from all providers in parallel
        const allProviderStreams = await withSpinner(`Fetching from ${selectedMatches.length} provider${selectedMatches.length !== 1 ? 's' : ''}...`, async () => {
            // Fetch from all providers in parallel for faster results
            const streams = await Promise.all(selectedMatches.map(match =>
                match.provider.extractStreamDirectByAnilistId(anilistId, targetEpisode, audio).catch(e => {
                    debugLog(`Failed to fetch from ${match.provider.name}: ${e.message}`);
                    return null;
                })
            ));

            return selectedMatches
                .map((match, i) => ({ provider: match.provider, stream: streams[i] }))
                .filter(x => x.stream && (x.stream.file || x.stream));
        });

        if (allProviderStreams.length === 0) {
            renderBox(t('app.error'), [t('boxes.failedToFetchStream')], C.red);
            await wait(1500);
            await handleAnimeSelection(selectedMatches);
            return;
        }

        // If multiple providers available, show combined selector
        let selectedStream = null;
        let selectedProvider = null;

        if (allProviderStreams.length > 1) {
            const providerOptions = allProviderStreams.map(({ provider, stream }) => {
                const qualityStr = stream.qualities && stream.qualities.length > 0 ? stream.qualities[0] : 'Default';
                const format = stream.file.includes('.m3u8') ? 'HLS' : 'MP4';
                return `${provider.name} • ${qualityStr} • ${format}`;
            });
            const providerIdx = await selectMenuOption(providerOptions, `\n  ${C.bold}${C.cyan}◈ ${t('streaming.selectProvider')}${C.reset}`, { allowBack: true, statusBar });
            if (providerIdx < 0) return;
            selectedStream = allProviderStreams[providerIdx].stream;
            selectedProvider = allProviderStreams[providerIdx].provider;
        } else {
            selectedStream = allProviderStreams[0].stream;
            selectedProvider = allProviderStreams[0].provider;
        }

        if (!selectedStream.file && !selectedStream.url) {
            renderBox(t('app.error'), [t('streaming.noStreamAvailable', { episode: targetEpisode })], C.red);
            await wait(1500);
            return;
        }

        if (selectedStream && !selectedStream.file && selectedStream.url) selectedStream.file = selectedStream.url;

        let selectedQuality = null;
        if (selectedStream.qualities && selectedStream.qualities.length > 1) {
            const qualityOptions = selectedStream.qualities.map(q => `${q}`);
            const qualityIdx = await selectMenuOption(qualityOptions, `\n  ${C.bold}${C.cyan}◈ ${t('streaming.selectQuality')}${C.reset}`, { allowBack: true, statusBar });
            if (qualityIdx >= 0) {
                selectedQuality = selectedStream.qualities[qualityIdx];
                if (selectedStream.qualityUrls && selectedStream.qualityUrls[selectedQuality]) {
                    selectedStream.file = selectedStream.qualityUrls[selectedQuality];
                    console.log(`  ${C.dim}Selected quality: ${selectedQuality}${C.reset}`);
                }
            }
        }

        const ext = settings.downloadFormat;
        const filename = `${animeTitle} - Episode ${targetEpisode} (${audio.toUpperCase()}).${ext}`;
        await resumeableDownload(selectedStream, filename, null, ext);
        return;
    }

    // Stream mode - play episodes
    let userWantsToContinue = true;
    let persistentSelectedProvider = null;  // Remember user's provider choice across episodes

    while (targetEpisode <= maxEpNum && userWantsToContinue) {
        try {
            const allProviderStreams = await withSpinner(`Fetching from ${selectedMatches.length} provider${selectedMatches.length !== 1 ? 's' : ''}...`, async () => {
                // Fetch from all matched providers in parallel for faster results
                const streams = await Promise.all(selectedMatches.map(match =>
                    match.provider.extractStreamDirectByAnilistId(anilistId, targetEpisode, audio).catch(e => {
                        debugLog(`Failed to fetch from ${match.provider.name} for episode ${targetEpisode}: ${e.message}`);
                        return null;
                    })
                ));

                return selectedMatches
                    .map((match, i) => ({ provider: match.provider, stream: streams[i] }))
                    .filter(x => x.stream && (x.stream.file || x.stream));
            });

            if (allProviderStreams.length === 0) {
                renderBox(t('app.error'), [t('streaming.noStreamAvailable', { episode: targetEpisode })], C.red);
                await wait(1500);
                break;
            }

            let selectedStream = null;
            let selectedProvider = null;

            // If multiple providers, show combined selector (unless user already picked one and wants to stick)
            if (allProviderStreams.length > 1) {
                // Show all provider+quality combinations
                const providerOptions = allProviderStreams.map(({ provider, stream }) => {
                    const qualityStr = stream.qualities && stream.qualities.length > 0 ? stream.qualities[0] : 'Default';
                    const format = stream.file.includes('.m3u8') ? 'HLS' : 'MP4';
                    return `${provider.name} • ${qualityStr} • ${format}`;
                });

                const providerIdx = await selectMenuOption(providerOptions, `\n  ${C.bold}${C.cyan}◈ ${t('streaming.selectProvider')}${C.reset}`, { allowBack: true, statusBar });
                if (providerIdx < 0) break;

                selectedStream = allProviderStreams[providerIdx].stream;
                selectedProvider = allProviderStreams[providerIdx].provider;
                persistentSelectedProvider = selectedProvider;  // Remember choice
            } else {
                selectedStream = allProviderStreams[0].stream;
                selectedProvider = allProviderStreams[0].provider;
                persistentSelectedProvider = selectedProvider;
            }

            if (!selectedStream.file && !selectedStream.url) throw new Error("Stream has no video file or url");
            if (selectedStream && !selectedStream.file && selectedStream.url) selectedStream.file = selectedStream.url;

            // Handle multiple servers from allServers array
            if (selectedStream.allServers && selectedStream.allServers.length > 1) {
                const serverOptions = selectedStream.allServers.map((s, i) => {
                    const quality = s.quality || `Server ${i+1}`;
                    const preview = s.file ? s.file.substring(0, 50) : 'N/A';
                    const format = s.file?.includes('.m3u8') ? 'HLS' : 'MP4';
                    return `${C.cyan}${quality}${C.reset}  ${C.dim}${format}  ${preview}${s.file && s.file.length > 50 ? '...' : ''}${C.reset}`;
                });
                const serverIdx = await selectMenuOption(serverOptions, `\n  ${C.bold}${C.cyan}◈ ${t('menus.multipleServersAvailable')}${C.reset}`, { allowBack: false, statusBar });
                if (serverIdx >= 0 && selectedStream.allServers[serverIdx]) {
                    const selectedServer = selectedStream.allServers[serverIdx];
                    selectedStream.file = selectedServer.file;
                    // Merge server-specific headers with response headers
                    if (selectedServer.headers) {
                        selectedStream.headers = { ...selectedStream.headers, ...selectedServer.headers };
                    }
                    console.log(`  ${C.green}✓${C.reset} ${C.dim}Selected:${C.reset} ${C.bold}${selectedServer.quality || `Server ${serverIdx+1}`}${C.reset}`);
                }
            }

            const streamInfo = [];
            streamInfo.push(`${C.bold}${C.green}✓ ${t('streaming.streamDetails')}${C.reset}`);

            // Display provider name from response or use selected provider
            const providerName = selectedStream.provider || selectedProvider.name;
            streamInfo.push(`${C.yellow}🔗${C.reset} ${C.dim}Provider:${C.reset} ${C.bold}${providerName}${C.reset}`);

            // Display server/CDN name from response if available
            if (selectedStream.server) {
                streamInfo.push(`${C.cyan}🖧${C.reset} ${C.dim}Server:${C.reset} ${C.bold}${selectedStream.server}${C.reset}`);
            }

            const audioIcon = audio === 'sub' ? `${C.cyan}◈${C.reset}` : `${C.magenta}◈${C.reset}`;
            streamInfo.push(`${audioIcon} ${C.dim}Audio:${C.reset} ${C.bold}${audio.toUpperCase()}${C.reset}`);

            // Display episode number from response
            if (selectedStream.episode !== undefined) {
                streamInfo.push(`${C.green}📺${C.reset} ${C.dim}Episode:${C.reset} ${C.bold}${selectedStream.episode}${C.reset}`);
            }

            const filePreview = selectedStream.file.substring(0, 65);
            streamInfo.push(`${C.dim}URL:${C.reset} ${C.dim}${filePreview}${selectedStream.file.length > 65 ? '...' : ''}${C.reset}`);

            // Display file format
            if (selectedStream.file.includes('.m3u8')) streamInfo.push(`${C.cyan}📡${C.reset} ${C.dim}Format:${C.reset} ${C.bold}HLS${C.reset} ${C.dim}(M3U8)${C.reset}`);
            else if (selectedStream.file.includes('.mp4')) streamInfo.push(`${C.blue}📦${C.reset} ${C.dim}Format:${C.reset} ${C.bold}MP4${C.reset}`);
            else if (selectedStream.file.includes('.mkv')) streamInfo.push(`${C.green}📦${C.reset} ${C.dim}Format:${C.reset} ${C.bold}MKV${C.reset}${C.dim} (Matroska)${C.reset}`);
            else streamInfo.push(`${C.dim}Format:${C.reset} ${C.bold}${selectedStream.file.split('.').pop().toUpperCase()}${C.reset}`);

            // Display available servers
            if (selectedStream.allServers && selectedStream.allServers.length > 0) {
                streamInfo.push(`${C.magenta}◈${C.reset} ${C.dim}Servers:${C.reset} ${C.cyan}${selectedStream.allServers.length}${C.reset} ${C.dim}available${C.reset}`);
            }

            // Display subtitle tracks
            if (selectedStream.tracks && selectedStream.tracks.length > 0) {
                const trackLabels = selectedStream.tracks.map(t => t.label || t.lang || 'default').join(', ');
                streamInfo.push(`${C.yellow}⚙${C.reset} ${C.dim}Subtitles:${C.reset} ${C.cyan}${selectedStream.tracks.length}${C.reset} ${C.dim}(${trackLabels})${C.reset}`);
            }

            // Display cache status if available
            if (selectedStream.cached !== undefined) {
                const cacheStatus = selectedStream.cached ? `${C.green}cached${C.reset}` : `${C.yellow}live${C.reset}`;
                streamInfo.push(`${C.dim}Status:${C.reset} ${cacheStatus}`);
            }

            renderBox(`${C.cyan}▶${C.reset} ${t('boxes.streamReady')}`, streamInfo, C.cyan);

            let selectedQuality = null;
            if (selectedStream.qualities && selectedStream.qualities.length > 1) {
                const preferredQual = settings.preferredQuality;
                selectedQuality = selectQuality(selectedStream.qualities, preferredQual);
                if (selectedQuality && selectedStream.qualityUrls && selectedStream.qualityUrls[selectedQuality]) {
                    selectedStream.file = selectedStream.qualityUrls[selectedQuality];
                }
            }

            if (selectedStream.tracks && selectedStream.tracks.length > 0) {
                const subChoice = await selectMenuOption([t('actions.downloadSubtitles'), t('actions.skip')], `\n  ${C.bold}${t('streaming.selectSubtitles')}${C.reset}`, { allowBack: false });
                if (subChoice === 0) {
                    const subsDir = path.join(DATA_DIR, 'subs', animeTitle.replace(/[<>:"/\\|?*]/g, '_'));
                    for (const sub of selectedStream.tracks) {
                        const subUrl = sub.file || sub.url;
                        if (!subUrl) continue;
                        let ext = '.srt';
                        if (subUrl) { const match = subUrl.match(/\.(vtt|ass|srt)(\?|$)/i); if (match) ext = '.' + match[1].toLowerCase(); }
                        const episodeNum = String(targetEpisode).padStart(2, '0');
                        const subLang = sub.label || sub.lang || 'default';
                        const subPath = path.join(subsDir, `E${episodeNum}.${audio.toUpperCase()}.${subLang}${ext}`);
                        const downloaded = await downloadSubtitle(subUrl, subPath);
                        if (downloaded) {
                            console.log(`  ${C.green}✓${C.reset} ${subLang} subtitle saved`);
                        }
                    }
                }
            }

            const episodeNumStr = String(targetEpisode).padStart(2, '0');
            const episodeDisplay = effectiveTotalEpisodes ? `${C.dim}${targetEpisode}/${effectiveTotalEpisodes}${C.reset}` : `${C.dim}${targetEpisode}/?${C.reset}`;
            const audioTag = audio === "sub" ? `${C.cyan}SUB${C.reset}` : `${C.magenta}DUB${C.reset}`;
            const qualityTag = selectedQuality ? `${C.magenta}${selectedQuality}${C.reset}` : '';
            const speedInfo = `${C.dim}${settings.playbackSpeed}x${C.reset}`;

            let playingTitle = `Episode ${episodeNumStr}`;

            const boxContent = [
                `${C.bold}${C.green}${animeTitle}${C.reset}`,
                `${C.bold}${C.cyan}Episode ${episodeNumStr}${C.reset}  ${episodeDisplay}`,
                `${C.yellow}${selectedProvider.name}${C.reset}  ${audioTag}  ${speedInfo}${qualityTag ? '  ' + qualityTag : ''}${C.reset}`
            ];

            renderBox(`${C.green}▶${C.reset} ${t('boxes.nowPlaying')}`, boxContent, C.green);

            saveToWatchlist(animeTitle, targetEpisode, audio, selectedMatches, effectiveTotalEpisodes ?? undefined, anilistId, 0, selectedQuality);
            await playWithMpv(selectedStream, `${animeTitle} — ${playingTitle}`, settings, animeTitle, targetEpisode, effectiveTotalEpisodes, audio, selectedProvider.name, 'stream-direct');

            if (targetEpisode < maxEpNum) {
                console.log(`\n  ${C.green}${C.bold}✓${C.reset} Episode ${C.bold}${targetEpisode}${C.reset} completed`);
                const result = await bingeCountdownWithProgress(settings.bingeCountdownSeconds, targetEpisode + 1, audio, "", () => { const newAudio = audio === "sub" ? "dub" : "sub"; updateWatchlistAudio(animeTitle, newAudio); }, settings.autoPlayNext);
                if (result.continue) {
                    if (result.newAudio) { audio = result.newAudio; console.log(`  ${C.yellow}◈${C.reset} Switched to ${C.bold}${audio.toUpperCase()}${C.reset}`); }
                    targetEpisode++;
                } else { userWantsToContinue = false; }
            } else { console.log(`\n  ${C.green}${C.bold}✓${C.reset} Series complete! Watched all ${C.bold}${targetEpisode}${C.reset} episodes`); break; }
        } catch (err) {
            const errorMsg = err.message || String(err);
            debugLog(`Stream/playback error: ${errorMsg}`);
            if (settings.autoRetryFailed) {
                console.log(`  ${C.yellow}⚠ ${errorMsg.substring(0, 60)}${C.reset}`);
                console.log(`  ${C.yellow}⚠ Retrying episode ${targetEpisode}...${C.reset}`);
                await wait(2000);
                continue;
            }
            renderBox(t('app.error'), [errorMsg], C.red);
            await wait(2000);
            break;
        }
    }
    console.log(`  ${C.dim}Session ended.${C.reset}`);
}

async function handleAnimeSelection(selectedMatches, startingEpisode, lockedAudio) {
    const settings = loadSettings();
    const coreTitle = selectedMatches[0]?.item.title || "Selected Anime";
    let providersList = await createProviders(settings.apiBaseUrl);
    providersList = filterEnabledProviders(providersList, settings);
    const statusBar = { providersCount: providersList.length, apiUrl: settings.apiBaseUrl };
    const hasSub = selectedMatches.some(m => m.item.hasSub);
    const hasDub = selectedMatches.some(m => m.item.hasDub);
    let audio = lockedAudio || settings.defaultAudio;
    
    if (!lockedAudio && hasSub && hasDub) {
        const audioIdx = await selectMenuOption([`${C.cyan}SUB${C.reset}  ${t('audio.subtitled')}`, `${C.magenta}DUB${C.reset}  ${t('audio.dubbed')}`], `\n  ${C.bold}${C.cyan}◈ ${t('menus.audioTrack')}${C.reset}`, { allowBack: true, statusBar });
        if (audioIdx === 1) audio = "dub";
        else if (audioIdx < 0) return;
    } else if (!lockedAudio && !hasSub && hasDub) audio = "dub";
    else if (!lockedAudio && hasSub && !hasDub) audio = "sub";

    let isDownloadMode = false, isBatchMode = false;
    const actionOptions = [
        `${C.green}▶${C.reset}  ${C.bold}${t('actions.streamOnline')}${C.reset}${C.dim}  ─ Fast & immediate playback${C.reset}`,
        `${C.cyan}⬇${C.reset}  ${C.bold}${t('actions.downloadSingleEpisode')}${C.reset}${C.dim}  ─ Save for offline${C.reset}`,
        `${C.magenta}⬇⬇${C.reset} ${C.bold}${t('actions.batchDownload')}${C.reset} ${C.dim}(${C.bold}MKV${C.dim})  ─ Download all episodes${C.reset}`
    ];
    const actionIdx = await selectMenuOption(actionOptions, `\n  ${C.bold}${C.cyan}◈ ${t('menus.whatWouldYouLikeToDo')}${C.reset}`, { allowBack: true, statusBar });
    if (actionIdx < 0) return;
    switch (actionIdx) {
        case 0: isDownloadMode = false; break;
        case 1: isDownloadMode = true; break;
        case 2: isDownloadMode = true; isBatchMode = true; break;
    }

    const cacheKey = `${coreTitle}|${selectedMatches.map(m => m.provider.name).join(',')}`;
    cleanCache(episodeListCache, settings.cacheMaxSize, settings.cacheTTL);
    let providerEpLists;
    if (episodeListCache.has(cacheKey)) {
        providerEpLists = episodeListCache.get(cacheKey).data;
        console.log(`  ${C.dim}Using cached episode list${C.reset}`);
    } else {
        try {
            providerEpLists = await withRetry(async () => {
                const lists = await Promise.all(selectedMatches.map(async (m) => {
                    try { const list = await m.provider.findEpisodes(m.item.url); return { provider: m.provider, list: Array.isArray(list) ? list : [] }; } catch(e) { return { provider: m.provider, list: [] }; }
                }));
                return lists;
            }, settings.maxRetries);
            episodeListCache.set(cacheKey, { data: providerEpLists, timestamp: Date.now() });
        } catch (err) { console.log(`  ${C.red}✗ Failed to fetch episodes${C.reset}`); return; }
    }
    
    const validLists = providerEpLists.filter(p => p.list && p.list.length > 0);
    if (!validLists.length) { renderBox(t('boxes.noEpisodes'), [t('boxes.noEpisodesReturned')], C.red); await wait(2000); return; }

    let maxEpNum = 0;
    for (const p of validLists) for (const ep of p.list) { const num = parseEpisodeNumber(ep); if (num && num > maxEpNum) maxEpNum = num; }
    if (maxEpNum === 0) { renderBox(t('app.error'), [t('boxes.invalidEpisodes')], C.red); await wait(1500); return; }

    const watchInfo = getWatchlistInfo(coreTitle);
    let effectiveTotalEpisodes = watchInfo?.totalEpisodes ?? null;
    let anilistIdForWorker = watchInfo?.anilistId ?? undefined;
    let seasonInfo = { season: null, seasonYear: null };

    if (!effectiveTotalEpisodes) {
        try {
            const totalData = await fetchTotalEpisodesFromWorker(coreTitle, anilistIdForWorker, settings.apiBaseUrl);
            if (totalData && totalData.totalEpisodes !== undefined && totalData.totalEpisodes !== null) { effectiveTotalEpisodes = totalData.totalEpisodes; anilistIdForWorker = totalData.anilistId || undefined; }
        } catch(e) {
            debugLog(`Failed to fetch total episodes: ${e.message}`);
        }
    }

    const titleMap = new Map();
    for (const ep of validLists.flatMap(p => p.list)) { const num = parseEpisodeNumber(ep); if (num && ep.title) titleMap.set(num, ep.title); }

    if (anilistIdForWorker) {
        try {
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000));
            const metaData = await Promise.race([fetchAnimeMetadata(coreTitle), timeoutPromise]);
            if (metaData) {
                seasonInfo = { season: metaData.season, seasonYear: metaData.seasonYear };
            }
        } catch(e) {
            debugLog(`AniList metadata fetch failed: ${e.message}`);
        }
    }

    let targetEpisode = startingEpisode || 1;
    if (!startingEpisode && !isBatchMode) {
        const picked = await selectEpisodeWithMarkers(maxEpNum, effectiveTotalEpisodes, coreTitle, statusBar, titleMap, seasonInfo);
        if (picked === -1) return;
        targetEpisode = picked;
    }

    if (isDownloadMode && isBatchMode) {
        const start = await askNumber(`\n  ${C.yellow}${t('labels.startEpisode')} (1–${maxEpNum})${C.reset}  ${C.bold}›${C.reset} `, 1, maxEpNum);
        const end = await askNumber(`  ${C.yellow}${t('labels.endEpisode')} (${start}–${maxEpNum})${C.reset}  ${C.bold}›${C.reset} `, start, maxEpNum);
        const sampleProviderServersMap = new Map();
        const batchAudioAvailability = new Map();

        for (const p of validLists) {
            const epObj = p.list.find(e => parseEpisodeNumber(e) === start);
            const dataIds = resolveEpisodeDataIds(epObj);
            if (dataIds) {
                try {
                    const servers = await p.provider.findAvailableServers(dataIds, audio);
                    if (servers.length) {
                        sampleProviderServersMap.set(p.provider, servers.map(s => ({ id: s.id, name: s.name })));
                        batchAudioAvailability.set(p.provider.name, audio);
                    } else {
                        const altAudio = audio === "dub" ? "sub" : "dub";
                        const altServers = await p.provider.findAvailableServers(dataIds, altAudio);
                        if (altServers.length) {
                            sampleProviderServersMap.set(p.provider, altServers.map(s => ({ id: s.id, name: s.name })));
                            batchAudioAvailability.set(p.provider.name, altAudio);
                        }
                    }
                } catch(e) {}
            }
        }

        if (sampleProviderServersMap.size === 0) { renderBox(t('app.error'), [t('boxes.noServers')], C.red); await wait(1500); return; }
        const selection = await selectServerTwoStep(sampleProviderServersMap, audio === "sub" ? "SUB" : "DUB", statusBar);
        if (!selection) return;
        const { provider: selectedProvider, serverId } = selection;

        const confirmedBatchAudio = batchAudioAvailability.get(selectedProvider.name) || audio;
        let selectedQuality = null;
        let sampleStream = null;
        if (anilistIdForWorker) {
            sampleStream = await withSpinner(`Fetching stream info for quality selection (direct)...`, async () => await selectedProvider.extractStreamDirectByAnilistId(anilistIdForWorker, start, confirmedBatchAudio));
        }
        if (!sampleStream) {
            sampleStream = await withSpinner(`Fetching stream info for quality selection...`, async () => await selectedProvider.extractStreamFromLinkId(serverId));
        }
        if (sampleStream.qualities && sampleStream.qualities.length > 1) {
            const qualityOptions = sampleStream.qualities.map(q => `${q}`);
            const qualityIdx = await selectMenuOption(qualityOptions, `\n  ${C.bold}${C.cyan}◈ ${t('streaming.selectQuality')}${C.reset}`, { allowBack: true, statusBar });
            if (qualityIdx >= 0) selectedQuality = sampleStream.qualities[qualityIdx];
        }

        const jobs = [];
        for (let ep = start; ep <= end; ep++) jobs.push({ episode: ep, title: titleMap.get(ep) || `Episode ${ep}`, provider: selectedProvider, serverId, serverName: selection.serverName, audio });
        await batchDownloadQueue(jobs, coreTitle, statusBar, selectedQuality);
        return;
    }

    if (isDownloadMode) {
        const downloadProviderServersMap = new Map();
        const downloadAudioAvailability = new Map();

        for (const p of validLists) {
            const epObj = p.list.find(e => parseEpisodeNumber(e) === targetEpisode);
            const dataIds = resolveEpisodeDataIds(epObj);
            if (dataIds) {
                try {
                    const servers = await p.provider.findAvailableServers(dataIds, audio);
                    if (servers.length) {
                        downloadProviderServersMap.set(p.provider, servers.map(s => ({ id: s.id, name: s.name })));
                        downloadAudioAvailability.set(p.provider.name, audio);
                    } else {
                        const altAudio = audio === "dub" ? "sub" : "dub";
                        const altServers = await p.provider.findAvailableServers(dataIds, altAudio);
                        if (altServers.length) {
                            downloadProviderServersMap.set(p.provider, altServers.map(s => ({ id: s.id, name: s.name })));
                            downloadAudioAvailability.set(p.provider.name, altAudio);
                        }
                    }
                } catch(e) {}
            }
        }

        if (downloadProviderServersMap.size === 0) { renderBox(t('app.error'), [t('boxes.noDownloadLinks')], C.red); await wait(1500); return; }
        const selection = await selectServerTwoStep(downloadProviderServersMap, audio === "sub" ? "SUB" : "DUB", statusBar);
        if (!selection) return;

        const confirmedDownloadAudio = downloadAudioAvailability.get(selection.provider.name) || audio;
        let stream = null;
        if (anilistIdForWorker) {
            stream = await withSpinner(`Fetching stream from ${selection.provider.name} (direct)...`, async () => await selection.provider.extractStreamDirectByAnilistId(anilistIdForWorker, targetEpisode, confirmedDownloadAudio));
        }
        if (!stream) {
            stream = await withSpinner(`Fetching stream from ${selection.provider.name}...`, async () => await selection.provider.extractStreamFromLinkId(selection.serverId));
        }
        if (stream && !stream.file && stream.url) stream.file = stream.url;

        let selectedQuality = null;
        if (stream.qualities && stream.qualities.length > 1) {
            const qualityOptions = stream.qualities.map(q => `${q}`);
            const qualityIdx = await selectMenuOption(qualityOptions, `\n  ${C.bold}${C.cyan}◈ ${t('streaming.selectQuality')}${C.reset}`, { allowBack: true, statusBar });
            if (qualityIdx >= 0) {
                selectedQuality = stream.qualities[qualityIdx];
                if (stream.qualityUrls && stream.qualityUrls[selectedQuality]) {
                    stream.file = stream.qualityUrls[selectedQuality];
                    console.log(`  ${C.dim}Selected quality: ${selectedQuality}${C.reset}`);
                }
            }
        }

        const ext = settings.downloadFormat;
        const filename = `${coreTitle} - Episode ${targetEpisode} (${audio.toUpperCase()}).${ext}`;
        await resumeableDownload(stream, filename, null, ext);
        return;
    }

    let userWantsToContinue = true, preferredProviderName = null, preferredServerName = null, currentAudio = audio;
    while (targetEpisode <= maxEpNum && userWantsToContinue) {
        const providerServersMap = new Map();
        const audioAvailability = new Map();

        for (const p of validLists) {
            const epObj = p.list.find(e => parseEpisodeNumber(e) === targetEpisode);
            const dataIds = resolveEpisodeDataIds(epObj);
            if (dataIds) {
                try {
                    const servers = await p.provider.findAvailableServers(dataIds, currentAudio);
                    if (servers.length) {
                        providerServersMap.set(p.provider, servers.map(s => ({ id: s.id, name: s.name })));
                        audioAvailability.set(p.provider.name, currentAudio);
                    } else {
                        const altAudio = currentAudio === "dub" ? "sub" : "dub";
                        const altServers = await p.provider.findAvailableServers(dataIds, altAudio);
                        if (altServers.length) {
                            audioAvailability.set(p.provider.name, altAudio);
                        }
                    }
                } catch(e) {}
            }
        }

        if (providerServersMap.size === 0) {
            const altAudio = currentAudio === "dub" ? "sub" : "dub";
            for (const p of validLists) {
                const epObj = p.list.find(e => parseEpisodeNumber(e) === targetEpisode);
                const dataIds = resolveEpisodeDataIds(epObj);
                if (dataIds) {
                    try {
                        const servers = await p.provider.findAvailableServers(dataIds, altAudio);
                        if (servers.length) {
                            providerServersMap.set(p.provider, servers.map(s => ({ id: s.id, name: s.name })));
                            audioAvailability.set(p.provider.name, altAudio);
                        }
                    } catch(e) {}
                }
            }
            if (providerServersMap.size === 0) { renderBox(t('app.error'), [t('boxes.noServers')], C.red); break; }
            currentAudio = altAudio;
            console.log(`  ${C.yellow}⚠ ${currentAudio.toUpperCase()} not available, using ${(currentAudio === "dub" ? "DUB" : "SUB")}${C.reset}`);
        }
        
        let selectedProvider = null, selectedServerId = null, selectedServerName = null;
        if (preferredProviderName && preferredServerName) {
            for (const [prov, servers] of providerServersMap.entries()) {
                if (prov.name === preferredProviderName) { const matchedServer = servers.find(s => s.name === preferredServerName); if (matchedServer) { selectedProvider = prov; selectedServerId = matchedServer.id; selectedServerName = matchedServer.name; break; } }
            }
            if (!selectedProvider) console.log(`  ${C.yellow}⚠ Preferred server unavailable — reselecting${C.reset}`);
        }
        if (!selectedProvider) {
            const selection = await selectServerTwoStep(providerServersMap, currentAudio === "sub" ? "SUB" : "DUB", statusBar);
            if (!selection) { userWantsToContinue = false; break; }
            selectedProvider = selection.provider; selectedServerId = selection.serverId; selectedServerName = selection.serverName;
            preferredProviderName = selectedProvider.name; preferredServerName = selectedServerName;
        }
        if (!selectedProvider || !selectedServerId) { renderBox(t('app.error'), [t('boxes.noServerSelected')], C.red); break; }
        
        try {
            const confirmedAudio = audioAvailability.get(selectedProvider.name) || currentAudio;
            let stream = null;
            if (anilistIdForWorker) {
                stream = await withSpinner(`Fetching stream from ${selectedProvider.name} (direct)...`, async () => await selectedProvider.extractStreamDirectByAnilistId(anilistIdForWorker, targetEpisode, confirmedAudio));
            }
            if (!stream) {
                stream = await withSpinner(`Fetching stream from ${selectedProvider.name}...`, async () => await selectedProvider.extractStreamFromLinkId(selectedServerId));
            }
            debugLog(`Stream received:`, JSON.stringify(stream).substring(0, 200));
            if (!stream) throw new Error("Stream is null/undefined");
            if (!stream.file && !stream.url) throw new Error("Stream has no video file or url");
            if (stream && !stream.file && stream.url) stream.file = stream.url;

            if (stream.allServers && stream.allServers.length > 1) {
                const serverOptions = stream.allServers.map((s, i) => {
                    const quality = s.quality || `Server ${i+1}`;
                    const format = s.file?.includes('.m3u8') ? 'HLS' : 'MP4';
                    const preview = s.file ? s.file.substring(0, 45) : 'N/A';
                    return `${C.cyan}${quality}${C.reset}  ${C.dim}${format}  ${preview}${s.file && s.file.length > 45 ? '...' : ''}${C.reset}`;
                });
                const serverIdx = await selectMenuOption(serverOptions, `\n  ${C.bold}${C.cyan}◈ ${t('menus.multipleServersAvailable')}${C.reset}`, { allowBack: false, statusBar });
                if (serverIdx >= 0 && stream.allServers[serverIdx]) {
                    const selectedServer = stream.allServers[serverIdx];
                    stream.file = selectedServer.file;
                    // Merge server-specific headers
                    if (selectedServer.headers) {
                        stream.headers = { ...stream.headers, ...selectedServer.headers };
                    }
                    console.log(`  ${C.green}✓${C.reset} ${C.dim}Selected:${C.reset} ${C.bold}${selectedServer.quality || `Server ${serverIdx+1}`}${C.reset}`);
                }
            }

            const streamInfo = [];
            streamInfo.push(`${C.bold}${C.green}${t('streaming.streamDetails')}${C.reset}`);

            // Display provider from response or fallback to selected provider
            const providerDisplay = stream.provider ? `${C.bold}${stream.provider}${C.reset}` : `${C.bold}${selectedProvider.name}${C.reset}`;
            streamInfo.push(`${C.dim}Provider:${C.reset} ${providerDisplay}`);

            // Display server/CDN info if available
            if (stream.server) {
                streamInfo.push(`${C.dim}Server:${C.reset} ${C.bold}${stream.server}${C.reset}`);
            } else if (selectedServerName) {
                streamInfo.push(`${C.dim}Server:${C.reset} ${C.bold}${selectedServerName}${C.reset}`);
            }

            // Display episode info if available
            if (stream.episode !== undefined) {
                streamInfo.push(`${C.dim}Episode:${C.reset} ${C.bold}${stream.episode}${C.reset}`);
            }

            streamInfo.push(`${C.dim}URL:${C.reset} ${stream.file.substring(0, 70)}${stream.file.length > 70 ? '...' : ''}`);

            // Display format
            if (stream.file.includes('.m3u8')) streamInfo.push(`${C.dim}Format:${C.reset} ${C.bold}HLS${C.reset} (M3U8)`);
            else if (stream.file.includes('.mp4')) streamInfo.push(`${C.dim}Format:${C.reset} ${C.bold}MP4${C.reset}`);
            else if (stream.file.includes('.mkv')) streamInfo.push(`${C.dim}Format:${C.reset} ${C.bold}Matroska${C.reset} (MKV)`);
            else streamInfo.push(`${C.dim}Format:${C.reset} ${C.bold}${stream.file.split('.').pop().toUpperCase()}${C.reset}`);

            // Display available servers
            if (stream.allServers && stream.allServers.length > 0) {
                const serverQualityList = stream.allServers.map(s => s.quality || 'default').join(', ');
                streamInfo.push(`${C.dim}Available:${C.reset} ${C.cyan}${stream.allServers.length}${C.reset} server(s) (${serverQualityList})`);
            }

            // Display subtitle tracks with languages
            if (stream.tracks && stream.tracks.length > 0) {
                const trackLabels = stream.tracks.map(t => t.label || t.lang || 'default').join(', ');
                streamInfo.push(`${C.dim}Subtitles:${C.reset} ${C.cyan}${stream.tracks.length}${C.reset} track(s) (${trackLabels})`);
            }

            // Display cache status if available
            if (stream.cached !== undefined) {
                const cacheStatus = stream.cached ? `${C.green}cached${C.reset}` : `${C.yellow}live${C.reset}`;
                streamInfo.push(`${C.dim}Status:${C.reset} ${cacheStatus}`);
            }

            renderBox(`▶ ${t('boxes.streamReady')}`, streamInfo, C.cyan);

            let selectedQuality = null;
            if (stream.qualities && stream.qualities.length > 1) {
                const preferredQual = watchInfo?.quality || settings.preferredQuality;
                selectedQuality = selectQuality(stream.qualities, preferredQual);
                if (selectedQuality && stream.qualityUrls && stream.qualityUrls[selectedQuality]) {
                    stream.file = stream.qualityUrls[selectedQuality];
                }
            }
            
            if (stream.tracks && stream.tracks.length > 0) {
                const subChoice = await selectMenuOption(["Download subtitles", "Skip"], `\n  ${C.bold}Subtitles available${C.reset}`, { allowBack: false });
                if (subChoice === 0) {
                    const subsDir = path.join(DATA_DIR, 'subs', coreTitle.replace(/[<>:"/\\|?*]/g, '_'));
                    for (const sub of stream.tracks) {
                        const subUrl = sub.file || sub.url;
                        if (!subUrl) continue;
                        let ext = '.srt';
                        if (subUrl) { const match = subUrl.match(/\.(vtt|ass|srt)(\?|$)/i); if (match) ext = '.' + match[1].toLowerCase(); }
                        const episodeNum = String(targetEpisode).padStart(2, '0');
                        const subLang = sub.label || sub.lang || 'default';
                        const subPath = path.join(subsDir, `E${episodeNum}.${currentAudio.toUpperCase()}.${subLang}${ext}`);
                        const downloaded = await downloadSubtitle(subUrl, subPath);
                        if (downloaded) {
                            console.log(`  ${C.green}✓${C.reset} ${subLang} subtitle saved`);
                        }
                    }
                }
            }
            
            const episodeNumStr = String(targetEpisode).padStart(2, '0');
            const epTitle = titleMap.get(targetEpisode);
            let seasonPrefix = '';
            if (seasonInfo.season) {
                const seasonNum = seasonInfo.season === 'winter' ? 1 : seasonInfo.season === 'spring' ? 2 : seasonInfo.season === 'summer' ? 3 : seasonInfo.season === 'fall' ? 4 : 1;
                seasonPrefix = `${C.bold}${C.cyan}S${seasonNum}E${episodeNumStr}${C.reset}`;
            }

            const episodeDisplay = effectiveTotalEpisodes ? `${C.dim}${targetEpisode}/${effectiveTotalEpisodes}${C.reset}` : `${C.dim}${targetEpisode}/?${C.reset}`;
            const audioTag = currentAudio === "sub" ? `${C.cyan}SUB${C.reset}` : `${C.magenta}DUB${C.reset}`;
            const qualityTag = selectedQuality ? `${C.magenta}${selectedQuality}${C.reset}` : '';
            const speedInfo = `${C.dim}${settings.playbackSpeed}x${C.reset}`;

            let playingTitle = seasonPrefix ? `${seasonPrefix}` : `Episode ${episodeNumStr}`;
            if (epTitle && epTitle.trim()) {
                playingTitle += ` — ${epTitle}`;
            }

            const boxContent = [
                `${C.bold}${C.green}${coreTitle}${C.reset}`,
            ];

            if (seasonPrefix) {
                boxContent.push(`${seasonPrefix}  ${episodeDisplay}`);
            } else {
                boxContent.push(`${C.bold}Episode ${episodeNumStr}${C.reset}  ${episodeDisplay}`);
            }

            if (epTitle && epTitle.trim()) {
                const titleText = epTitle.length > 70 ? epTitle.slice(0, 67) + '…' : epTitle;
                boxContent.push(`${C.yellow}${titleText}${C.reset}`);
            }

            const infoParts = [selectedProvider.name, selectedServerName, audioTag];
            if (qualityTag) infoParts.push(qualityTag);
            infoParts.push(speedInfo);
            boxContent.push(`${C.dim}${infoParts.join(`  ${C.dim}·${C.reset}  `)}${C.reset}`);

            renderBox(`▶ ${t('boxes.nowPlaying')}`, boxContent, C.green);

            saveToWatchlist(coreTitle, targetEpisode, currentAudio, selectedMatches, effectiveTotalEpisodes ?? undefined, anilistIdForWorker, 0, selectedQuality, seasonInfo);
            await playWithMpv(stream, `${coreTitle} — ${playingTitle}`, settings, coreTitle, targetEpisode, effectiveTotalEpisodes, currentAudio, selectedProvider.name, selectedServerName);
            
            if (targetEpisode < maxEpNum) {
                console.log(`\n  ${C.green}✓ Episode ${targetEpisode} done${C.reset}`);
                const nextTitle = titleMap.get(targetEpisode + 1) || "";
                const result = await bingeCountdownWithProgress(settings.bingeCountdownSeconds, targetEpisode + 1, currentAudio, nextTitle, () => { const newAudio = currentAudio === "sub" ? "dub" : "sub"; updateWatchlistAudio(coreTitle, newAudio); }, settings.autoPlayNext);
                if (result.continue) {
                    if (result.newAudio) { currentAudio = result.newAudio; console.log(`  ${C.yellow}◈ Switched to ${currentAudio.toUpperCase()}${C.reset}`); }
                    targetEpisode++;
                } else { userWantsToContinue = false; }
            } else { console.log(`  ${C.green}✓ Finished last episode!${C.reset}`); break; }
        } catch (err) {
            const errorMsg = err.message || String(err);
            debugLog(`Stream/playback error: ${errorMsg}`);
            if (settings.autoRetryFailed) {
                console.log(`  ${C.yellow}⚠ ${errorMsg.substring(0, 60)}${C.reset}`);
                console.log(`  ${C.yellow}⚠ Retrying episode ${targetEpisode}...${C.reset}`);
                await wait(2000);
                continue;
            }
            renderBox(t('app.error'), [errorMsg], C.red);
            await wait(2000);
            break;
        }
    }
    console.log(`  ${C.dim}Session ended.${C.reset}`);
}

async function triggerQuickResume(providersList) {
    const list = loadWatchlist();
    if (list.length === 0) { renderBox(t('app.info'), [t('boxes.watchlistEmptyMessage')], C.dim); await wait(1200); return; }
    const last = list[0];
    const mappedMatches = [];
    for (const match of last.matches) {
        const foundProvider = providersList.find(p => p.name === match.providerName);
        if (foundProvider) mappedMatches.push({ provider: foundProvider, item: { title: last.title, url: match.url, hasSub: match.hasSub, hasDub: match.hasDub } });
    }
    if (mappedMatches.length === 0) { renderBox(t('app.error'), [t('boxes.cannotRestoreProvider')], C.red); await wait(1500); return; }
    await handleAnimeSelection(mappedMatches, last.lastEpisode + 1, last.audio);
}

async function triggerRecentSearchesWorkflow(providersList) {
    const history = loadSearchHistory();
    if (history.length === 0) {
        clearScreen();
        renderHeader("RECENT SEARCHES", "");
        renderBox(t('app.info'), [t('boxes.noSearchesSaved')], C.dim);
        await pauseForKey();
        return;
    }
    const options = [...history.map((query, idx) => `${padRightVisible(query, 48)} ${C.dim}#${idx + 1}${C.reset}`), `${C.dim}Clear all${C.reset}`, `${C.dim}Go back${C.reset}`];
    const selectedIdx = await selectMenuOption(options, `\n  ${C.bold}${C.magenta}◈ Recent searches${C.reset}`, { allowBack: true });
    if (selectedIdx < 0 || selectedIdx === history.length + 1) return;
    if (selectedIdx === history.length) {
        const confirm = await selectMenuOption(["Yes, clear all", "No, go back"], `\n  ${C.bold}${C.red}Clear all recent searches?${C.reset}`, { allowBack: true });
        if (confirm === 0) { clearSearchHistory(); renderBox(t('boxes.done'), [t('boxes.searchesCleared')], C.green); }
        await wait(1000);
        return;
    }
    const selectedQuery = history[selectedIdx];
    const actionOptions = [`Search "${selectedQuery}"`, `Delete this entry`, `Go back`];
    const actionIdx = await selectMenuOption(actionOptions, `\n  ${C.bold}${C.cyan}◈ ${selectedQuery}${C.reset}`, { allowBack: true });
    switch (actionIdx) {
        case 0: await triggerSearchWorkflow(selectedQuery, providersList); break;
        case 1: deleteSearchHistoryItem(selectedIdx); renderBox(t('boxes.done'), [t('boxes.searchDeleted')], C.green); await wait(800); break;
    }
}

async function triggerWatchlistWorkflow(providersList) {
    if (!providersList) providersList = await createProviders(loadSettings().apiBaseUrl);
    const list = loadWatchlist();
    if (list.length === 0) {
        clearScreen();
        renderHeader("WATCHLIST", "");
        renderBox(t('app.info'), [t('boxes.watchlistEmptyStart')], C.dim);
        await wait(2000);
        return;
    }
    const options = list.map((item) => {
        const epStr = String(item.lastEpisode).padStart(2, '0');
        let epDisplay = `${C.bold}${C.green}E${epStr}${C.reset}`;

        if (item.season) {
            const seasonMap = { winter: '❄️', spring: '🌸', summer: '☀️', fall: '🍂' };
            const seasonEmoji = seasonMap[item.season.toLowerCase()] || '📺';
            epDisplay = `${seasonEmoji} ${C.bold}${C.cyan}S${epStr}${C.reset}`;
            if (item.seasonYear) {
                epDisplay += ` ${C.dim}(${item.seasonYear})${C.reset}`;
            }
        }

        if (item.totalEpisodes) {
            epDisplay += `${C.dim}/${C.bold}${item.totalEpisodes}${C.reset}`;
        } else {
            epDisplay += `${C.dim}/?${C.reset}`;
        }

        const audioTag = item.audio === "sub" ? `${C.cyan}◈ SUB${C.reset}` : `${C.magenta}◈ DUB${C.reset}`;
        const dateStr = item.lastWatched ? new Date(item.lastWatched).toLocaleDateString() : item.timestamp?.split('T')[0] || '';
        const progressPercent = item.totalEpisodes ? Math.round((item.lastEpisode / item.totalEpisodes) * 100) : 0;
        const barLength = 5;
        let progressBar = '';
        if (progressPercent > 0) {
            const filled = Math.ceil((progressPercent / 100) * barLength);
            progressBar = ` ${C.green}[${C.bold}${'▮'.repeat(filled)}${C.reset}${C.green}${' '.repeat(barLength - filled)}]${C.reset}`;
        }

        return `${padRightVisible(item.title, 35)}  ${epDisplay}  ${audioTag}${progressBar}  ${C.dim}${dateStr}${C.reset}`;
    });
    options.push(`${C.dim}Clear watchlist${C.reset}`, `${C.dim}Go back${C.reset}`);
    const selectedIdx = await selectMenuOption(options, `\n  ${C.bold}${C.magenta}◈ Watchlist${C.reset}`, { allowBack: true });
    if (selectedIdx < 0) return;
    if (selectedIdx === list.length) {
        const confirm = await selectMenuOption(["Yes, clear all", "No, go back"], `\n  ${C.bold}${C.red}Clear entire watchlist?${C.reset}`, { allowBack: true });
        if (confirm === 0) { clearWatchlist(); renderBox(t('boxes.done'), [t('messages.removedFromWatchlist')], C.green); }
        await wait(1200);
        return;
    }
    if (selectedIdx === list.length + 1) return;
    const targetItem = list[selectedIdx];
    const nextEpNum = targetItem.lastEpisode + 1;
    const nextEpStr = String(nextEpNum).padStart(2, '0');
    const lastEpStr = String(targetItem.lastEpisode).padStart(2, '0');
    const totalHint = targetItem.totalEpisodes ? `/${targetItem.totalEpisodes}` : '/?';
    const audioStatus = targetItem.audio === "sub" ? `${C.cyan}SUB${C.reset}` : `${C.magenta}DUB${C.reset}`;
    const actionOptions = [
        `${C.green}▶${C.reset}  ${C.bold}Resume${C.reset} E${nextEpStr}${totalHint}`,
        `${C.yellow}↺${C.reset}  Replay E${lastEpStr}${totalHint}`,
        `${C.cyan}⏮${C.reset}  Start from E01`,
        `${C.magenta}✎${C.reset}  Edit progress`,
        `${C.blue}◈${C.reset}  Toggle audio (${audioStatus})`,
        `${C.green}✓${C.reset}  Mark completed`,
        `${C.dim}○${C.reset}  Mark unwatched`,
        `${C.cyan}⟳${C.reset}  Refresh episodes`,
        `${C.red}✕${C.reset}  Remove from watchlist`,
        `← Go back`
    ];
    const actionIdx = await selectMenuOption(actionOptions, `\n  ${C.bold}${C.cyan}◈ ${targetItem.title}${C.reset}`, { allowBack: true });
    if (actionIdx < 0 || actionIdx === actionOptions.length - 1) return;
    switch (actionIdx) {
        case 7:
            const totalData = await fetchTotalEpisodesFromWorker(targetItem.title, targetItem.anilistId, loadSettings().apiBaseUrl);
            if (totalData && totalData.totalEpisodes !== null) {
                const idx = list.findIndex(item => item.title.toLowerCase() === targetItem.title.toLowerCase());
                if (idx !== -1) {
                    list[idx].totalEpisodes = totalData.totalEpisodes;
                    if (totalData.anilistId) list[idx].anilistId = totalData.anilistId;
                    saveWatchlist(list);
                    renderBox(t('boxes.updated'), [`Total episodes set to ${totalData.totalEpisodes}`], C.green);
                } else { renderBox(t('app.error'), ["Entry not found."], C.red); }
            } else { renderBox(t('app.error'), ["Could not fetch total episodes."], C.red); }
            await wait(1200);
            break;
        case 8:
            deleteWatchlistItem(selectedIdx);
            renderBox(t('boxes.done'), [t('boxes.removed')], C.green);
            await wait(1000);
            break;
        case 4:
            const newAudio = targetItem.audio === "sub" ? "dub" : "sub";
            updateWatchlistAudio(targetItem.title, newAudio);
            renderBox(t('boxes.updated'), [t('boxes.audioSwitched') + ` ${newAudio.toUpperCase()}`], C.green);
            await wait(1000);
            break;
        case 5:
            if (targetItem.totalEpisodes && targetItem.totalEpisodes > 0) {
                updateWatchlistEpisode(targetItem.title, targetItem.totalEpisodes);
                renderBox(t('boxes.done'), [`${targetItem.title} ${t('boxes.markedCompleted')}`], C.green);
            } else {
                const manualEp = await askNumber(`\n  ${C.yellow}Final episode number${C.reset}  ${C.bold}›${C.reset} `, 1, 9999);
                updateWatchlistEpisode(targetItem.title, manualEp);
                renderBox(t('boxes.done'), [t('boxes.lastEpisodeSet') + ` ${manualEp}`], C.green);
            }
            await wait(1200);
            break;
        case 6:
            updateWatchlistEpisode(targetItem.title, 0);
            renderBox(t('boxes.updated'), [`${targetItem.title} ${t('boxes.markedUnwatched')}`], C.green);
            await wait(1000);
            break;
        case 3:
            const newEp = await askNumber(`\n  ${C.yellow}New last watched episode (current: ${targetItem.lastEpisode})${C.reset}  ${C.bold}›${C.reset} `, 0, 9999);
            updateWatchlistEpisode(targetItem.title, newEp);
            renderBox(t('boxes.updated'), [t('boxes.episodeProgress') + ` ${newEp}`], C.green);
            await wait(1000);
            break;
        default:
            const mappedMatches = [];
            for (const match of targetItem.matches) {
                const foundProvider = providersList.find(p => p.name === match.providerName);
                if (foundProvider) mappedMatches.push({ provider: foundProvider, item: { title: targetItem.title, url: match.url, hasSub: match.hasSub, hasDub: match.hasDub } });
            }
            if (mappedMatches.length === 0) { renderBox(t('app.error'), [t('boxes.failedToRestoreProvider')], C.red); await wait(1500); return; }
            let startEpisode = 1;
            if (actionIdx === 0) startEpisode = targetItem.lastEpisode + 1;
            else if (actionIdx === 1) startEpisode = targetItem.lastEpisode;
            else if (actionIdx === 2) startEpisode = 1;
            await handleAnimeSelection(mappedMatches, startEpisode, targetItem.audio);
            break;
    }
}

async function triggerProviderManagementWorkflow(allProviders) {
    while (true) {
        const settings = loadSettings();
        const enabledProviders = settings.enabledProviders || [];
        const totalProviders = allProviders.length;
        const enabledCount = enabledProviders.length;
        const disabledCount = totalProviders - enabledCount;

        clearScreen();
        renderHeader("PROVIDER MANAGEMENT", `${enabledCount}/${totalProviders} providers enabled`);
        console.log();

        const options = allProviders.map((provider, idx) => {
            const isEnabled = enabledProviders.includes(provider.name);
            const statusIcon = isEnabled ? `${C.green}✓${C.reset}` : `${C.dim}○${C.reset}`;
            const num = String(idx + 1).padStart(2, "0");
            return `${statusIcon}  ${num}  ${C.bold}${provider.name}${C.reset}`;
        });

        options.push(`${C.cyan}ℹ${C.reset}  Enable all providers`);
        options.push(`${C.red}✗${C.reset}  Disable all providers`);
        options.push(t('app.back'));

        const idx = await selectMenuOption(options, `\n  ${C.bold}${C.magenta}🔌${C.reset}  ${C.bold}Manage Providers${C.reset}  ${C.dim}(${enabledCount} enabled, ${disabledCount} disabled)${C.reset}`, { allowBack: true });

        if (idx < 0 || idx === options.length - 1) return;

        if (idx < allProviders.length) {
            const selectedProvider = allProviders[idx];
            const isCurrentlyEnabled = enabledProviders.includes(selectedProvider.name);

            if (isCurrentlyEnabled) {
                settings.enabledProviders = enabledProviders.filter(p => p !== selectedProvider.name);
            } else {
                settings.enabledProviders = [...enabledProviders, selectedProvider.name];
            }
            saveSettings(settings);
        } else if (idx === allProviders.length) {
            settings.enabledProviders = allProviders.map(p => p.name);
            saveSettings(settings);
            renderBox(t('app.success'), [`All ${allProviders.length} providers enabled`], C.green);
            await wait(800);
        } else if (idx === allProviders.length + 1) {
            settings.enabledProviders = [];
            saveSettings(settings);
            renderBox(t('app.warning'), ["No providers enabled. Searches will not work until you enable at least one provider."], C.yellow);
            await wait(1200);
        }
    }
}

async function triggerSettingsWorkflow(providersCount) {
    while (true) {
        const settings = loadSettings();
        const options = [
            `${C.cyan}🌐${C.reset} ${t('settings.language')}${" ".repeat(20)}${C.dim}${getLanguageName(settings.language)}${C.reset}`,
            `${C.yellow}⏱${C.reset}  Binge delay${" ".repeat(21)}${C.dim}${settings.bingeCountdownSeconds}s${C.reset}`,
            `${C.magenta}🔊${C.reset} ${t('settings.defaultAudio')}${" ".repeat(12)}${C.dim}${settings.defaultAudio === "sub" ? t('audio.subtitled') : t('audio.dubbed')}${C.reset}`,
            `${C.cyan}▶${C.reset}  ${t('settings.playbackSpeed')}${" ".repeat(15)}${C.dim}${settings.playbackSpeed}x${C.reset}`,
            `${settings.autoPlayNext ? `${C.green}✓${C.reset}` : `${C.dim}○${C.reset}`}  Auto-play next${" ".repeat(18)}${settings.autoPlayNext ? `${C.green}ON${C.reset}` : `${C.dim}OFF${C.reset}`}`,
            `${settings.resumePlayback ? `${C.green}✓${C.reset}` : `${C.dim}○${C.reset}`}  ${t('settings.resumePlayback')}${" ".repeat(8)}${settings.resumePlayback ? `${C.green}ON${C.reset}` : `${C.dim}OFF${C.reset}`}`,
            `${settings.discordEnabled ? `${C.green}✓${C.reset}` : `${C.dim}○${C.reset}`}  Discord RPC${" ".repeat(21)}${settings.discordEnabled ? `${C.green}ON${C.reset}` : `${C.dim}OFF${C.reset}`}`,
            `${C.green}📁${C.reset} ${t('settings.downloadDir')}${" ".repeat(10)}${C.dim}${settings.downloadDir.length > 30 ? '...' + settings.downloadDir.slice(-27) : settings.downloadDir}${C.reset}`,
            `${C.blue}📦${C.reset} ${t('settings.downloadFormat')}${" ".repeat(13)}${C.dim}${settings.downloadFormat.toUpperCase()}${C.reset}`,
            `${C.yellow}🔗${C.reset} API base URL${" ".repeat(19)}${C.dim}${settings.apiBaseUrl}${C.reset}`,
            `${C.magenta}⚡${C.reset} Min similarity${" ".repeat(17)}${C.dim}${settings.minSimilarityScore}%${C.reset}`,
            `${settings.enableNotifications ? `${C.green}✓${C.reset}` : `${C.dim}○${C.reset}`}  ${t('settings.enableNotifications')}${" ".repeat(3)}${settings.enableNotifications ? `${C.green}ON${C.reset}` : `${C.dim}OFF${C.reset}`}`,
            `${settings.autoRetryFailed ? `${C.green}✓${C.reset}` : `${C.dim}○${C.reset}`}  Auto retry${" ".repeat(22)}${settings.autoRetryFailed ? `${C.green}ON${C.reset}` : `${C.dim}OFF${C.reset}`}`,
            `${C.magenta}🔌${C.reset} Manage Providers${" ".repeat(17)}${C.dim}Filter enabled sources${C.reset}`,
            `${C.cyan}🗑${C.reset}  Clear cache`,
            `${C.red}⚠${C.reset}  Reset all settings`,
            `${t('app.back')}`
        ];
        const idx = await selectMenuOption(options, `\n  ${C.bold}${C.cyan}⚙${C.reset}  ${C.bold}${t('settings.title')}${C.reset}`, { allowBack: true, statusBar: { providersCount, apiUrl: settings.apiBaseUrl } });
        if (idx < 0 || idx === options.length - 1) return;
        switch (idx) {
            case 0:
                const availableLangs = getAvailableLanguages();
                const langNames = availableLangs.map(lang => getLanguageName(lang));
                const langIdx = await selectMenuOption(langNames, `\n  ${C.bold}${C.cyan}${t('settings.selectLanguage')}${C.reset}`, { allowBack: true });
                if (langIdx >= 0) {
                    const selectedLang = availableLangs[langIdx];
                    settings.language = selectedLang;
                    loadLanguage(selectedLang);
                    saveSettings(settings);
                    renderBox(t('app.success'), [`${t('settings.language')}: ${getLanguageName(selectedLang)}`], C.green);
                    await wait(1200);
                }
                break;
            case 1:
                const values = [3,5,8,10,15,20,30];
                const valueIdx = await selectMenuOption(values.map(v => `${v}s`), `\n  ${C.bold}${C.cyan}Binge delay${C.reset}`, { allowBack: true });
                if (valueIdx >= 0) { settings.bingeCountdownSeconds = values[valueIdx]; saveSettings(settings); }
                break;
            case 2:
                const audioOpts = [`${t('audio.subtitled')} (sub)`, `${t('audio.dubbed')} (dub)`];
                const audioIdx = await selectMenuOption(audioOpts, `\n  ${C.bold}${C.cyan}${t('settings.defaultAudio')}${C.reset}`, { allowBack: true });
                if (audioIdx >= 0) { settings.defaultAudio = audioIdx === 0 ? "sub" : "dub"; saveSettings(settings); }
                break;
            case 3:
                const speeds = [0.75,1.0,1.25,1.5,1.75,2.0];
                const speedIdx = await selectMenuOption(speeds.map(s => `${s}x`), `\n  ${C.bold}${C.cyan}${t('settings.playbackSpeed')}${C.reset}`, { allowBack: true });
                if (speedIdx >= 0) { settings.playbackSpeed = speeds[speedIdx]; saveSettings(settings); }
                break;
            case 4:
                settings.autoPlayNext = !settings.autoPlayNext;
                saveSettings(settings);
                renderBox(t('app.success'), [`Auto-play next: ${settings.autoPlayNext ? "ON" : "OFF"}`], C.green);
                await wait(800);
                break;
            case 5:
                settings.resumePlayback = !settings.resumePlayback;
                saveSettings(settings);
                renderBox(t('app.success'), [`${t('settings.resumePlayback')}: ${settings.resumePlayback ? "ON" : "OFF"}`], C.green);
                await wait(800);
                break;
            case 6:
                settings.discordEnabled = !settings.discordEnabled;
                if (settings.discordEnabled && !discordRpc) initDiscordRpc(settings.discordClientId);
                else if (!settings.discordEnabled && discordRpc) { discordRpc.destroy().catch(() => {}); discordRpc = null; discordReady = false; }
                saveSettings(settings);
                renderBox(t('app.success'), [`Discord RPC: ${settings.discordEnabled ? "ON" : "OFF"}`], C.green);
                await wait(800);
                break;
            case 7:
                const newDir = await askQuestion(`\n  ${C.yellow}Download directory (full path)${C.reset}  ${C.bold}›${C.reset} `);
                if (newDir.trim()) {
                    const resolved = path.resolve(newDir.trim());
                    if (!fs.existsSync(resolved)) try { fs.mkdirSync(resolved, { recursive: true }); } catch(e) {}
                    if (fs.existsSync(resolved)) { settings.downloadDir = resolved; saveSettings(settings); renderBox(t('boxes.saved'), [`Download directory → ${settings.downloadDir}`], C.green); }
                    else { renderBox(t('app.error'), [t('boxes.directoryNotExist')], C.red); }
                    await wait(1200);
                }
                break;
            case 8:
                const formatOpts = ["MKV (mkv)", "MP4 (mp4)"];
                const formatIdx = await selectMenuOption(formatOpts, `\n  ${C.bold}${C.cyan}Download format${C.reset}`, { allowBack: true });
                if (formatIdx >= 0) { settings.downloadFormat = formatIdx === 0 ? "mkv" : "mp4"; saveSettings(settings); }
                break;
            case 9:
                const newUrl = await askQuestion(`\n  ${C.yellow}API base URL${C.reset}  ${C.bold}›${C.reset} `);
                if (newUrl.trim()) { settings.apiBaseUrl = newUrl.trim(); saveSettings(settings); renderBox(t('boxes.saved'), [t('boxes.apiUrlUpdated') + ` ${settings.apiBaseUrl}`], C.green); await wait(1200); }
                break;
            case 10:
                const minScore = await askNumber(`\n  ${C.yellow}Minimum similarity score (1-100)${C.reset}  ${C.bold}›${C.reset} `, 1, 100);
                settings.minSimilarityScore = minScore;
                saveSettings(settings);
                renderBox(t('boxes.saved'), [t('boxes.minSimilarityUpdated') + `: ${settings.minSimilarityScore}%`], C.green);
                await wait(1200);
                break;
            case 11:
                settings.enableNotifications = !settings.enableNotifications;
                saveSettings(settings);
                renderBox(t('boxes.updated'), [t('boxes.notificationsUpdated') + `: ${settings.enableNotifications ? "ON" : "OFF"}`], C.green);
                await wait(800);
                break;
            case 12:
                settings.autoRetryFailed = !settings.autoRetryFailed;
                saveSettings(settings);
                renderBox(t('boxes.updated'), [t('boxes.autoRetryUpdated') + `: ${settings.autoRetryFailed ? "ON" : "OFF"}`], C.green);
                await wait(800);
                break;
            case 13:
                const providersList = await createProviders(settings.apiBaseUrl);
                await triggerProviderManagementWorkflow(providersList);
                break;
            case 14:
                clearAllCaches();
                renderBox(t('boxes.done'), [t('boxes.allCachesCleared')], C.green);
                await wait(1000);
                break;
            case 15:
                saveSettings(defaultSettings);
                clearAllCaches();
                renderBox(t('boxes.done'), [t('boxes.settingsReset')], C.green);
                await wait(1200);
                break;
        }
    }
}

async function triggerProviderOverviewWorkflow(providersList) {
    if (!providersList) providersList = await createProviders(loadSettings().apiBaseUrl);
    const settings = loadSettings();
    const enabledProviders = settings.enabledProviders || [];
    const enabledCount = enabledProviders.length > 0 ? enabledProviders.length : providersList.length;
    const disabledCount = providersList.length - enabledCount;

    clearScreen();
    renderHeader("PROVIDERS", `${enabledCount}/${providersList.length} enabled`);
    console.log();
    providersList.forEach((provider, idx) => {
        const num = String(idx + 1).padStart(2, "0");
        const isEnabled = enabledProviders.length === 0 || enabledProviders.includes(provider.name);
        const statusIcon = isEnabled ? `${C.green}✓${C.reset}` : `${C.dim}○${C.reset}`;
        const nameColor = isEnabled ? `${C.bold}${C.cyan}` : `${C.dim}`;
        console.log(`  ${C.dim}${num}${C.reset}  ${statusIcon}  ${nameColor}${provider.name}${C.reset}`);
    });
    console.log();
    renderBox(`${C.blue}🌐${C.reset} ${t('app.info')}`, [
        `${C.green}✓${C.reset} ${C.dim}${enabledCount}/${providersList.length} providers enabled for searching${C.reset}`,
        `${C.yellow}🔗${C.reset} ${C.dim}API: ${loadSettings().apiBaseUrl}${C.reset}`,
        `${C.magenta}🔌${C.reset} ${C.dim}Go to Settings → Manage Providers to configure${C.reset}`
    ], C.blue);
    await pauseForKey();
}

if (process.argv.includes('--version') || process.argv.includes('-v')) { console.log(`kittycli v${APP_VERSION}`); process.exit(0); }
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`kittycli v${APP_VERSION} — anime aggregator terminal client`);
    console.log(''); console.log('Usage: kittycli [options]'); console.log('');
    console.log('Options:');
    console.log('  -v, --version   Show version');
    console.log('  -h, --help      Show this help');
    console.log('  --debug         Enable verbose logging');
    console.log('');
    console.log(`Data directory: ${DATA_DIR}`); process.exit(0);
}

async function terminalEngine() {
    let settings = loadSettings();
    // Initialize i18n with user's language preference
    if (settings.language) {
        loadLanguage(settings.language);
    }
    if (settings.enableUpdateCheck) {
        const latest = await checkForUpdates();
        if (latest) {
            console.log(`\n  ${C.yellow}${C.bold}⬆${C.reset} Update available: ${C.bold}${latest}${C.reset}  ${C.dim}(current: ${APP_VERSION})${C.reset}`);
            console.log(`  ${C.dim}Run: npm update -g @fampep/kittycli${C.reset}\n`);
            await wait(2000);
        }
    }
    
    const isApiReachable = await checkApiServer(settings.apiBaseUrl);
    if (!isApiReachable) {
        console.log(`  ${C.yellow}⚠ API server unreachable — opening settings...${C.reset}`);
        await pauseForKey("Press any key to open settings...");
        await triggerSettingsWorkflow(0);
        settings = loadSettings();
        const reachable = await checkApiServer(settings.apiBaseUrl);
        if (!reachable) {
            renderBox(t('boxes.fatal'), [t('boxes.stillCannotConnect')], C.red);
            rl.close();
            return;
        }
    }

    if (settings.discordEnabled && !discordRpc) {
        initDiscordRpc(settings.discordClientId);
        await wait(500);
    }

    let providersList = await createProviders(settings.apiBaseUrl);
    const allProvidersCount = providersList.length;
    const enabledProviders = settings.enabledProviders || [];
    const providersCount = enabledProviders.length > 0 ? enabledProviders.length : allProvidersCount;

    while (true) {
        const watchlistCount = loadWatchlist().length;
        const historyCount = loadSearchHistory().length;
        clearScreen();
        renderHeader("KITTYCLI", `v${APP_VERSION}  ·  ${providersCount}/${allProvidersCount} providers`);
        const W = 72;
        const formatQuality = settings.downloadFormat.toUpperCase();
        console.log(`  ${C.bold}${C.green}┌${"─".repeat(W)}┐${C.reset}`);
        console.log(`  ${C.bold}${C.green}│${C.reset}  ${C.cyan}📺 Watchlist${C.reset}  ${C.bold}${C.green}${watchlistCount}${C.reset} item${watchlistCount !== 1 ? 's' : ''}${" ".repeat(W - 18 - String(watchlistCount).length)}${C.bold}${C.green}│${C.reset}`);
        console.log(`  ${C.bold}${C.green}│${C.reset}  ${C.magenta}🔍 Searches${C.reset}  ${C.bold}${C.magenta}${historyCount}${C.reset} saved${" ".repeat(W - 18 - String(historyCount).length)}${C.bold}${C.green}│${C.reset}`);
        console.log(`  ${C.bold}${C.green}│${C.reset}  ${C.yellow}🌐 API${C.reset}       ${C.dim}${settings.apiBaseUrl.length > 42 ? settings.apiBaseUrl.substring(0, 39) + '...' : settings.apiBaseUrl}${" ".repeat(Math.max(0, W - 11 - Math.min(42, settings.apiBaseUrl.length)))}${C.reset}${C.bold}${C.green}│${C.reset}`);
        console.log(`  ${C.bold}${C.green}│${C.reset}  ${settings.discordEnabled ? `${C.green}● Discord${C.reset}` : `${C.dim}○ Discord${C.reset}`}   ${C.dim}${formatQuality} downloads${C.reset}${" ".repeat(Math.max(0, W - 27))}${C.bold}${C.green}│${C.reset}`);
        console.log(`  ${C.bold}${C.green}└${"─".repeat(W)}┘${C.reset}\n`);
        
        const mainOptions = [
            `${C.green}🔍${C.reset} ${C.bold}${t('mainMenu.search')}${C.reset}${C.dim}  ─ Find and stream anime${C.reset}`,
            `${C.cyan}📜${C.reset} ${C.bold}${t('mainMenu.recentSearches')}${C.reset}  ${historyCount > 0 ? `${C.green}${historyCount}${C.reset}` : `${C.dim}none${C.reset}`}${C.dim} saved${C.reset}`,
            `${C.magenta}📺${C.reset} ${C.bold}${t('mainMenu.watchlist')}${C.reset}        ${watchlistCount > 0 ? `${C.green}${watchlistCount}${C.reset}` : `${C.dim}empty${C.reset}`}${C.dim} items${C.reset}`,
            `${C.yellow}▶${C.reset} ${C.bold}${t('mainMenu.quickResume')}${C.reset}       ${watchlistCount > 0 ? `${C.green}ready${C.reset}` : `${C.dim}none${C.reset}`}`,
            `${C.blue}🌐${C.reset} ${C.bold}${t('mainMenu.providers')}${C.reset}        ${C.cyan}${providersCount}/${allProvidersCount}${C.reset} ${C.dim}enabled${C.reset}`,
            `${C.cyan}🐱${C.reset} ${C.bold}${t('mainMenu.github')}${C.reset}${C.dim}         ─ View on GitHub${C.reset}`,
            `${C.green}⚙${C.reset} ${C.bold}${t('mainMenu.settings')}${C.reset}${C.dim}        ─ Customize experience${C.reset}`,
            `${C.yellow}❓${C.reset} ${C.bold}${t('mainMenu.helpAbout')}${C.reset}${C.dim}    ─ Show help and features${C.reset}`,
            `${C.dim}${t('mainMenu.exit')}${C.reset}`
        ];
        
        const choiceIdx = await selectMenuOption(mainOptions, ``, { statusBar: { providersCount, apiUrl: settings.apiBaseUrl } });
        switch (choiceIdx) {
            case 0: await triggerSearchWorkflow(undefined, providersList); break;
            case 1: await triggerRecentSearchesWorkflow(providersList); break;
            case 2: await triggerWatchlistWorkflow(providersList); break;
            case 3: await triggerQuickResume(providersList); break;
            case 4: await triggerProviderOverviewWorkflow(providersList); break;
            case 5: openUrl(GITHUB_URL); renderBox(t('boxes.github'), [t('boxes.openingRepository')], C.green); await wait(1500); break;
            case 6: await triggerSettingsWorkflow(providersCount); break;
            case 7: await showHelp(); break;
            case 8:
                if (settings.confirmBeforeExit) {
                    const confirm = await selectMenuOption([t('actions.yes'), t('actions.no')], `\n  ${C.yellow}${t('menus.exitKittycli')}${C.reset}`, { allowBack: true });
                    if (confirm !== 0) break;
                }
                rl.close();
                clearScreen();
                console.log(`\n  ${C.green}${C.bold}✓${C.reset} Thanks for using ${C.bold}KittyCLI${C.reset}! See you next time~ ${C.cyan}🐱${C.reset}\n`);
                return;
        }
    }
}

process.on('SIGINT', () => {
    if (discordRpc) discordRpc.destroy().catch(() => {});
    console.log(`\n  ${C.green}${C.bold}✓${C.reset} Thanks for using ${C.bold}KittyCLI${C.reset}! See you next time~ ${C.cyan}🐱${C.reset}\n`);
    try { rl.close(); } catch(e) {}
    process.exit(0);
});

process.on('unhandledRejection', (reason) => {
    console.error(`\n  ${C.red}✗ Unhandled rejection:${C.reset}`, reason?.message || reason);
    debugLog('Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error(`\n  ${C.red}✗ Unexpected error:${C.reset}`, err.message);
    debugLog('Uncaught exception:', err);
    try { rl.close(); } catch(e) {}
    process.exit(1);
});

terminalEngine().catch(err => {
    console.error(`  ${C.red}✗ Fatal:${C.reset}`, err.message ?? err);
    debugLog('Fatal error:', err);
    try { rl.close(); } catch(e) {}
    process.exit(1);
});