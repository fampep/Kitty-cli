#!/usr/bin/env node

import axios from 'axios';
import { spawn, execSync } from 'child_process';
import readline from 'readline';
import path from 'path';
import os from 'os';
import fs from 'fs';
import DiscordRPC from 'discord-rpc';

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

const APP_VERSION = "2.2.1";
const GITLAB_PROJECT = "fampep/kitty-cli";
const VERSION_CHECK_URL = `https://gitlab.com/api/v4/projects/${encodeURIComponent(GITLAB_PROJECT)}/releases/permalink/latest`;
const GITHUB_URL = "https://github.com/fampep/Kitty-cli";

const DATA_DIR = path.join(os.homedir(), '.kittycli');
const WATCHLIST_PATH = path.join(DATA_DIR, 'watchlist.json');
const SEARCH_HISTORY_PATH = path.join(DATA_DIR, 'search-history.json');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const CACHE_PATH = path.join(DATA_DIR, 'cache.json');

if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e) {}
}

const defaultSettings = {
    defaultAction: "ask",
    bingeCountdownSeconds: 10,
    pageSize: 12,
    apiBaseUrl: "https://fampepanikotoapi.buzz",
    defaultAudio: "sub",
    mpvArgs: "",
    playbackSpeed: 1.0,
    enableUpdateCheck: true,
    autoPlayNext: false,
    discordEnabled: false,
    discordClientId: "1511784156340818222"
};

// Discord RPC instance (singleton)
let discordRpc = null;
let discordReady = false;

function initDiscordRpc(clientId) {
    if (discordRpc) return;
    DiscordRPC.register(clientId);
    discordRpc = new DiscordRPC.Client({ transport: 'ipc' });
    discordRpc.on('ready', () => {
        discordReady = true;
        console.log(`  ${C.green}✓ Discord RPC connected${C.reset}`);
    });
    discordRpc.login({ clientId }).catch(err => {
        console.log(`  ${C.yellow}⚠ Discord RPC failed: ${err.message}${C.reset}`);
        discordReady = false;
    });
}

function setDiscordPresence(animeTitle, episodeNum, totalEpisodes, audio, streamUrl) {
    if (!discordReady || !discordRpc) return;
    const state = totalEpisodes
        ? `Episode ${episodeNum}/${totalEpisodes} · ${audio.toUpperCase()}`
        : `Episode ${episodeNum} · ${audio.toUpperCase()}`;
    discordRpc.setActivity({
        details: `Watching ${animeTitle}`,
        state: state,
        startTimestamp: Date.now(),
        largeImageKey: 'kitty_logo',   // You MUST upload this asset in your Discord Developer app
        largeImageText: 'KittyCLI',
        smallImageKey: 'play',
        smallImageText: 'Streaming',
        buttons: [
            { label: '🎬 Watch Episode', url: streamUrl },
            { label: '🐱 GitHub', url: GITHUB_URL }
        ],
        instance: false
    }).catch(err => console.error('Discord RPC setActivity error:', err));
}

function clearDiscordPresence() {
    if (!discordReady || !discordRpc) return;
    discordRpc.clearActivity().catch(err => console.error('Discord RPC clear error:', err));
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
    return text.replace(/<[^>]*>/g, '');
}

function loadCache() { return []; }
function saveCache() {}
function getCachedSearch() { return null; }
function setCachedSearch() {}

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
                    id description(asHtml: false) averageScore genres episodes status
                }
            }
        `;
        const response = await axios.post('https://graphql.anilist.co', { query, variables: { search: title } }, { timeout: 5000 });
        const media = response.data.data?.Media;
        if (media) {
            return {
                synopsis: media.description?.substring(0, 500) + (media.description?.length > 500 ? '...' : ''),
                rating: media.averageScore ? media.averageScore / 10 : undefined,
                genres: media.genres,
                episodes: media.episodes,
                status: media.status,
                anilistId: media.id
            };
        }
    } catch(e) {}
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

function saveToWatchlist(title, episode, audio, selectedMatches, totalEpisodes, anilistId) {
    try {
        const list = loadWatchlist();
        const existingIdx = list.findIndex(item => item.title.toLowerCase() === title.toLowerCase());
        const matchesData = selectedMatches.map(m => ({
            providerName: m.provider.name,
            url: m.item.url,
            hasSub: m.item.hasSub,
            hasDub: m.item.hasDub
        }));
        const newItem = { title, lastEpisode: episode, audio, timestamp: new Date().toLocaleDateString(), matches: matchesData, totalEpisodes, anilistId };
        if (existingIdx !== -1) {
            if (totalEpisodes === undefined && list[existingIdx].totalEpisodes) newItem.totalEpisodes = list[existingIdx].totalEpisodes;
            if (anilistId === undefined && list[existingIdx].anilistId) newItem.anilistId = list[existingIdx].anilistId;
            list[existingIdx] = newItem;
        } else list.unshift(newItem);
        saveWatchlist(list);
    } catch(e) {}
}

function deleteWatchlistItem(index) {
    const list = loadWatchlist();
    if (index >= 0 && index < list.length) { list.splice(index, 1); saveWatchlist(list); }
}

function updateWatchlistEpisode(title, newEpisode) {
    const list = loadWatchlist();
    const idx = list.findIndex(item => item.title.toLowerCase() === title.toLowerCase());
    if (idx !== -1) { list[idx].lastEpisode = newEpisode; saveWatchlist(list); }
}

function updateWatchlistAudio(title, audio) {
    const list = loadWatchlist();
    const idx = list.findIndex(item => item.title.toLowerCase() === title.toLowerCase());
    if (idx !== -1) { list[idx].audio = audio; saveWatchlist(list); }
}

function clearWatchlist() { try { if (fs.existsSync(WATCHLIST_PATH)) fs.rmSync(WATCHLIST_PATH, { force: true }); } catch(e) {} }

function readJsonFile(filePath, fallback) {
    try { if (!fs.existsSync(filePath)) return fallback; return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch(e) { return fallback; }
}

function writeJsonFile(filePath, value) { try { fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8'); } catch(e) {} }

function loadSettings() {
    const stored = readJsonFile(SETTINGS_PATH, {});
    return {
        defaultAction: stored.defaultAction === "stream" || stored.defaultAction === "download" ? stored.defaultAction : "ask",
        bingeCountdownSeconds: typeof stored.bingeCountdownSeconds === "number" ? Math.min(Math.max(stored.bingeCountdownSeconds, 3), 120) : defaultSettings.bingeCountdownSeconds,
        pageSize: typeof stored.pageSize === "number" ? Math.min(Math.max(stored.pageSize, 6), 20) : defaultSettings.pageSize,
        apiBaseUrl: typeof stored.apiBaseUrl === "string" && stored.apiBaseUrl.trim() ? stored.apiBaseUrl.trim() : defaultSettings.apiBaseUrl,
        defaultAudio: stored.defaultAudio === "dub" ? "dub" : "sub",
        mpvArgs: typeof stored.mpvArgs === "string" ? stored.mpvArgs : defaultSettings.mpvArgs,
        playbackSpeed: typeof stored.playbackSpeed === "number" ? Math.min(Math.max(stored.playbackSpeed, 0.5), 3.0) : 1.0,
        enableUpdateCheck: typeof stored.enableUpdateCheck === "boolean" ? stored.enableUpdateCheck : true,
        autoPlayNext: typeof stored.autoPlayNext === "boolean" ? stored.autoPlayNext : false,
        discordEnabled: typeof stored.discordEnabled === "boolean" ? stored.discordEnabled : false,
        discordClientId: typeof stored.discordClientId === "string" && stored.discordClientId.trim() ? stored.discordClientId.trim() : defaultSettings.discordClientId
    };
}

function saveSettings(settings) { writeJsonFile(SETTINGS_PATH, settings); }

function loadSearchHistory() {
    const history = readJsonFile(SEARCH_HISTORY_PATH, []);
    return Array.isArray(history) ? history.filter(item => typeof item === "string" && item.trim()).slice(0, 30) : [];
}

function saveSearchToHistory(query) {
    const clean = query.trim();
    if (!clean) return;
    const next = [clean, ...loadSearchHistory().filter(item => item.toLowerCase() !== clean.toLowerCase())].slice(0, 30);
    writeJsonFile(SEARCH_HISTORY_PATH, next);
}

function deleteSearchHistoryItem(index) {
    const history = loadSearchHistory();
    if (index >= 0 && index < history.length) { history.splice(index, 1); writeJsonFile(SEARCH_HISTORY_PATH, history); }
}

function clearSearchHistory() { try { if (fs.existsSync(SEARCH_HISTORY_PATH)) fs.rmSync(SEARCH_HISTORY_PATH, { force: true }); } catch(e) {} }

function clearScreen() {
    console.clear();
}

function stripAnsi(value) { return value.replace(/\x1b\[[0-9;]*m/g, ""); }
function visibleLength(value) { return stripAnsi(value).length; }
function padRightVisible(value, width) { return value + " ".repeat(Math.max(0, width - visibleLength(value))); }

function renderBox(title, content, color = C.green) {
    const maxLen = Math.max(title.length, ...content.map(l => visibleLength(l))) + 4;
    const top    = `${color}╭${"─".repeat(maxLen)}╮${C.reset}`;
    const titleLine = `${color}│${C.reset} ${C.bold}${color}${title}${C.reset}${" ".repeat(maxLen - title.length - 1)}${color}│${C.reset}`;
    const mid    = `${color}├${"─".repeat(maxLen)}┤${C.reset}`;
    const bottom = `${color}╰${"─".repeat(maxLen)}╯${C.reset}`;
    console.log(top);
    console.log(titleLine);
    console.log(mid);
    for (const line of content) {
        console.log(`${color}│${C.reset} ${line}${" ".repeat(maxLen - visibleLength(line) - 1)}${color}│${C.reset}`);
    }
    console.log(bottom);
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
    const logo =
`${C.green}${C.bold}  ██╗  ██╗██╗████████╗████████╗██╗   ██╗ ██████╗██╗     ██╗${C.reset}
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
    console.log(`${C.bold}${C.green}╚${line}╝${C.reset}`);
}

function renderStatusBar(providersCount, apiUrl, additional) {
    const W = process.stdout.columns || 100;
    const parts = [
        `${C.bold}${C.green}🐱 kittycli${C.reset} ${C.dim}v${APP_VERSION}${C.reset}`,
        `${C.cyan}${providersCount}${C.reset}${C.dim} providers${C.reset}`,
        `${C.dim}api:${C.reset} ${C.yellow}${apiUrl}${C.reset}`,
        additional || `${C.dim}↑↓ move  ↵ select  1-9 jump  q back  ? help${C.reset}`
    ];
    console.log(`\n${C.dim}${"─".repeat(W)}${C.reset}`);
    console.log(parts.join(`  ${C.dim}│${C.reset}  `));
    console.log(`${C.dim}${"─".repeat(W)}${C.reset}`);
}

function normalizeTitle(title) { return title.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim(); }

function resolveEpisodeDataIds(epObj) {
    if (!epObj) return null;
    if (epObj.dataIds != null) return epObj.dataIds;
    if (epObj.id != null) return epObj.id;
    if (epObj.episodeId != null) return epObj.episodeId;
    if (epObj.data_id != null) return epObj.data_id;
    if (epObj.dataId != null) return epObj.dataId;
    if (epObj.sourceId != null) return epObj.sourceId;
    if (epObj.linkId != null) return epObj.linkId;
    return null;
}

function getWatchlistInfo(title) {
    const list = loadWatchlist();
    const normalized = normalizeTitle(title);
    const item = list.find(i => normalizeTitle(i.title) === normalized);
    if (item) return { lastEpisode: item.lastEpisode, totalEpisodes: item.totalEpisodes, audio: item.audio, anilistId: item.anilistId };
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
        process.stdin.once('data', () => {
            process.stdin.setRawMode(isRaw);
            resolve();
        });
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
        process.stdout.write(`\r  ${C.green}✓${C.reset} ${message}${" ".repeat(10)}\n`);
        return result;
    } catch (err) {
        clearInterval(interval);
        process.stdout.write(`\r  ${C.red}✗${C.reset} ${message}${" ".repeat(10)}\n`);
        throw err;
    }
}

function isMpvAvailable() {
    const cmd = os.platform() === "win32" ? "where mpv" : "which mpv";
    try { execSync(cmd, { stdio: 'ignore' }); return true; } catch(e) { return false; }
}

async function copyToClipboard(text) {
    return new Promise((resolve) => {
        let cmd, args;
        if (os.platform() === 'darwin') { cmd = 'pbcopy'; args = []; }
        else if (os.platform() === 'win32') { cmd = 'clip'; args = []; }
        else { cmd = 'xclip'; args = ['-selection', 'clipboard']; }
        const proc = spawn(cmd, args, { stdio: 'pipe' });
        proc.stdin.write(text);
        proc.stdin.end();
        proc.on('close', (code) => resolve(code === 0));
        proc.on('error', () => resolve(false));
    });
}

async function downloadSubtitle(subtitleUrl, outputPath) {
    try {
        const response = await axios({ url: subtitleUrl, method: 'GET', responseType: 'text' });
        fs.writeFileSync(outputPath, response.data);
        return true;
    } catch(e) { return false; }
}

async function playWithMpv(stream, displayTitle, settings, animeTitle, episodeNum, totalEpisodes, audio) {
    if (!isMpvAvailable()) {
        renderBox("error", ["mpv not installed. cannot play video."], C.red);
        return false;
    }
    // Initialize Discord RPC if enabled and not already connected
    if (settings.discordEnabled && !discordRpc) {
        initDiscordRpc(settings.discordClientId);
        await wait(500);
    }
    if (settings.discordEnabled && discordReady && stream && stream.file) {
        setDiscordPresence(animeTitle, episodeNum, totalEpisodes, audio, stream.file);
    }
    return new Promise((resolve) => {
        console.log(`\n  ${C.cyan}◈${C.reset} ${C.bold}launching mpv...${C.reset}`);
        const baseArgs = [
            stream.file,
            `--referrer=${stream.headers.Referer}`,
            `--http-header-fields=Origin: ${stream.headers.Origin}`,
            "--keep-open=no",
            "--save-position-on-quit=yes",
            "--resume-playback=yes",
            `--speed=${settings.playbackSpeed}`,
            `--title=${displayTitle}`
        ];
        let args = baseArgs;
        if (settings.mpvArgs && settings.mpvArgs.trim()) {
            const extra = settings.mpvArgs.trim().split(/\s+/);
            args = [...baseArgs, ...extra];
        }
        const mpv = spawn('mpv', args, { stdio: 'inherit' });
        mpv.on('close', (code) => {
            if (settings.discordEnabled && discordReady) {
                clearDiscordPresence();
            }
            resolve(code === 0);
        });
        mpv.on('error', (err) => { 
            console.log(`  ${C.red}✗ mpv error: ${err.message}${C.reset}`);
            if (settings.discordEnabled && discordReady) clearDiscordPresence();
            resolve(false); 
        });
    });
}

async function downloadWithFfmpegProgress(url, outputPath) {
    return new Promise((resolve) => {
        const args = ['-i', url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-y', outputPath];
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
                    const filled = Math.round(percent / 5);
                    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
                    process.stdout.write(`\r  ${C.cyan}[${bar}]${C.reset} ${C.bold}${percent.toFixed(1)}%${C.reset}  `);
                }
            }
        });
        ffmpeg.on('close', (code) => {
            console.log();
            if (code === 0) { console.log(`  ${C.green}✓ download complete!${C.reset}`); resolve(true); }
            else { console.log(`  ${C.red}✗ ffmpeg failed.${C.reset}`); resolve(false); }
        });
        ffmpeg.on('error', (err) => { console.log(`  ${C.red}✗ ffmpeg error: ${err.message}${C.reset}`); resolve(false); });
    });
}

async function resumeableDownload(serverDetails, suggestedFilename, onProgress) {
    const cleanFilename = suggestedFilename.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
    const downloadsDir = path.join(os.homedir(), 'Downloads');
    const outputDir = fs.existsSync(downloadsDir) ? downloadsDir : process.cwd();
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
        renderBox("saving to", [downloadPath], C.cyan);
        partial = {
            url: serverDetails.file,
            outputPath: downloadPath,
            downloadedBytes: 0,
            totalBytes: 0,
            headers: serverDetails.headers
        };
    }

    const pd = partial;

    if (serverDetails.file.includes('.m3u8')) {
        console.log(`  ${C.magenta}◈ hls stream detected — using ffmpeg${C.reset}`);
        return downloadWithFfmpegProgress(serverDetails.file, downloadPath);
    }

    try {
        const headers = {
            'Referer': pd.headers.Referer,
            'Origin': pd.headers.Origin,
            'User-Agent': USER_AGENT
        };
        if (pd.downloadedBytes > 0) headers['Range'] = `bytes=${pd.downloadedBytes}-`;

        const response = await axios({
            url: pd.url,
            method: 'GET',
            responseType: 'stream',
            headers,
            timeout: 30000
        });

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
                        const filled = Math.round((pd.downloadedBytes / pd.totalBytes) * 28);
                        const bar = `${C.green}${'█'.repeat(filled)}${C.reset}${C.dim}${'░'.repeat(28 - filled)}${C.reset}`;
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
                resolve(true);
            });

            writer.on('error', (err) => {
                fs.writeFileSync(metaPath, JSON.stringify(pd, null, 2));
                reject(err);
            });

            response.data.on('error', (err) => {
                fs.writeFileSync(metaPath, JSON.stringify(pd, null, 2));
                reject(err);
            });
        });
    } catch (err) {
        renderBox("download error", [err.message], C.red);
        return false;
    }
}

async function batchDownloadQueue(jobs, coreTitle, statusBar) {
    console.log(`\n  ${C.bold}${C.green}◈ batch download  ${C.cyan}${jobs.length} episodes${C.reset}\n`);
    let successCount = 0, failCount = 0;
    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        console.log(`  ${C.dim}[${i+1}/${jobs.length}]${C.reset} ${C.cyan}episode ${job.episode}${C.reset}`);
        try {
            const stream = await withSpinner(`fetching stream from ${job.provider.name}...`, async () => {
                return await job.provider.extractStreamFromLinkId(job.serverId);
            });
            const ext = stream.file.includes('.m3u8') ? '.mp4' : (stream.file.match(/\.(mp4|mkv|mov|avi)($|\?)/)?.[1] || 'mp4');
            const filename = `${coreTitle} - Episode ${job.episode} (${job.audio.toUpperCase()}).${ext}`;
            const success = await resumeableDownload(stream, filename);
            if (success) successCount++;
            else failCount++;
        } catch (err) {
            console.log(`  ${C.red}✗ ${err.message}${C.reset}`);
            failCount++;
        }
    }
    console.log(`\n  ${C.green}✓ ${successCount} done${C.reset}  ${failCount > 0 ? `${C.red}✗ ${failCount} failed${C.reset}` : ''}`);
    await pauseForKey();
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const askQuestion = (q) => new Promise(res => rl.question(q, res));

let renderScheduled = false;

async function selectMenuOption(options, title, config = {}) {
    return new Promise((resolve) => {
        if (options.length === 0) { resolve(-1); return; }
        let currentPos = 0, resolved = false;
        const pageSize = config.pageSize ?? loadSettings().pageSize;
        const pageCount = Math.max(1, Math.ceil(options.length / pageSize));
        const canUseRawMode = process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
        if (!canUseRawMode) {
            console.log(title);
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
        
        const renderMenu = () => {
            clearScreen();
            console.log(title);
            const page = Math.floor(currentPos / pageSize);
            const start = page * pageSize;
            const visibleOptions = options.slice(start, start + pageSize);
            console.log();
            visibleOptions.forEach((opt, offset) => {
                const idx = start + offset;
                const numberHint = offset < 9 ? `${C.dim}${offset + 1}${C.reset}` : " ";
                if (idx === currentPos) {
                    const raw = stripAnsi(opt);
                    const padded = raw.length < W - 8 ? opt + " ".repeat(W - 8 - raw.length) : opt;
                    console.log(`  ${C.bgGreen}${C.green}${C.bold} > ${numberHint}${C.green}  ${padded} ${C.reset}`);
                } else {
                    console.log(`  ${C.white}${C.dim}  ${numberHint}${C.reset}  ${opt}${C.reset}`);
                }
            });
            console.log();
            const footerParts = ["↑↓ move", "↵ select", "1-9 jump"];
            if (pageCount > 1) footerParts.push(`page ${page+1}/${pageCount}`);
            if (config.allowBack) footerParts.push("q back");
            console.log(`  ${C.dim}${footerParts.join("  ·  ")}${C.reset}`);
            if (config.statusBar) renderStatusBar(config.statusBar.providersCount, config.statusBar.apiUrl);
        };
        
        const scheduleRender = () => {
            if (renderScheduled) return;
            renderScheduled = true;
            setTimeout(() => {
                renderMenu();
                renderScheduled = false;
            }, 10);
        };
        
        const keyHandler = (_str, key) => {
            if (resolved) return;
            if (key && key.name === '?' && !key.ctrl && !key.meta) {
                showHelpGuide().then(() => scheduleRender());
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
        
        const cleanup = () => { 
            process.stdin.removeListener('keypress', keyHandler); 
            process.stdin.setRawMode(isRaw); 
        };
        
        renderMenu();
        process.stdin.on('keypress', keyHandler);
    });
}

async function showHelpGuide() {
    clearScreen();
    renderHeader("HELP GUIDE", `kittycli v${APP_VERSION}`);
    const content = [
        `${C.bold}${C.cyan}navigation${C.reset}`,
        `  ${C.green}↑ ↓${C.reset}        move through menu`,
        `  ${C.green}↵${C.reset}          select item`,
        `  ${C.green}1 – 9${C.reset}      quick-pick visible row`,
        `  ${C.green}home / end${C.reset} jump to top / bottom`,
        `  ${C.green}pgup / pgdn${C.reset} change page`,
        `  ${C.green}?${C.reset}          this help screen`,
        ``,
        `${C.bold}${C.cyan}features${C.reset}`,
        `  ${C.green}◈${C.reset} multi-provider parallel search`,
        `  ${C.green}◈${C.reset} watchlist with episode progress`,
        `  ${C.green}◈${C.reset} resumable & batch downloads`,
        `  ${C.green}◈${C.reset} binge mode with audio toggle (A key)`,
        `  ${C.green}◈${C.reset} copy stream url to clipboard`,
        `  ${C.green}◈${C.reset} subtitle download`,
        `  ${C.green}◈${C.reset} anime metadata panel (anilist)`,
        `  ${C.green}◈${C.reset} fuzzy search ranking`,
        `  ${C.green}◈${C.reset} playback speed control`,
        `  ${C.green}◈${C.reset} Discord Rich Presence with GitHub button`,
        ``,
        `${C.bold}${C.cyan}player${C.reset}`,
        `  mpv  (only supported player)`,
        ``,
        `${C.bold}${C.cyan}api${C.reset}`,
        `  ${C.dim}current:${C.reset} ${C.yellow}${loadSettings().apiBaseUrl}${C.reset}`,
        `  ${C.dim}change in settings → api base url${C.reset}`
    ];
    renderBox("help", content, C.cyan);
    return pauseForKey();
}

async function bingeCountdownWithProgress(seconds, nextEpisodeNum, currentAudio, nextEpisodeTitle, onAudioToggle, autoPlayNext) {
    if (autoPlayNext) {
        return { continue: true };
    }
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
        console.log(`  ${C.yellow}continue to episode ${nextEpisodeNum}? (auto-continue in ${seconds}s)${C.reset}`);
        await wait(seconds * 1000);
        return { continue: true };
    }
    return new Promise((resolve) => {
        let remaining = seconds, resolved = false;
        const isRaw = process.stdin.isRaw;
        process.stdin.setRawMode(true);
        let audio = currentAudio;
        const render = () => {
            const filled = Math.round((remaining / seconds) * 24);
            const bar = `${C.green}${'█'.repeat(filled)}${C.reset}${C.dim}${'░'.repeat(24 - filled)}${C.reset}`;
            const audioTag = audio === "sub" ? `${C.cyan}SUB${C.reset}` : `${C.magenta}DUB${C.reset}`;
            const titleDisplay = nextEpisodeTitle ? ` ${C.dim}—${C.reset} ${C.dim}${nextEpisodeTitle}${C.reset}` : "";
            process.stdout.write(`\r  ${C.bold}${C.green}▶ ep ${nextEpisodeNum}${C.reset}${titleDisplay}  [${bar}] ${C.bold}${remaining}s${C.reset}  ${C.dim}Y continue  N stop  A toggle${C.reset} [${audioTag}]  `);
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
                if (!resolved) { resolved = true; clearInterval(timer); process.stdin.setRawMode(isRaw); process.stdin.removeListener('data', onData); console.log(`\n  ${C.dim}binge stopped.${C.reset}`); resolve({ continue: false }); }
            } else if (key === 'a') {
                audio = audio === "sub" ? "dub" : "sub";
                onAudioToggle();
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
        renderBox("connection error", [
            `cannot reach  ${baseUrl}`,
            "check the server is running and the url is correct."
        ], C.red);
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
            const response = await axios.get(`${this.baseUrl}/provider/${this.name}/search`, {
                params: { q: query, dub: dub.toString() },
                timeout: 15000
            });
            return response.data;
        } catch (err) {
            console.error(`API error for ${this.name}.search:`, err.message);
            return [];
        }
    }

    async findEpisodes(seriesUrl) {
        try {
            const response = await axios.get(`${this.baseUrl}/provider/${this.name}/episodes`, {
                params: { url: seriesUrl },
                timeout: 15000
            });
            let data = response.data;
            if (data && typeof data === 'object') {
                if (Array.isArray(data)) return data;
                const arrayKeys = ['episodes', 'data', 'results', 'list', 'items', 'episodeList',
                                   'episode_list', 'eps', 'content', 'records', 'payload'];
                for (const key of arrayKeys) {
                    if (data[key] && Array.isArray(data[key]) && data[key].length > 0) return data[key];
                }
                for (const val of Object.values(data)) {
                    if (Array.isArray(val) && val.length > 0) return val;
                }
            }
            console.warn(`[${this.name}] unexpected episodes response shape. raw:`, JSON.stringify(data).slice(0, 400));
            return [];
        } catch (err) {
            console.error(`API error for ${this.name}.findEpisodes:`, err.message);
            return [];
        }
    }

    async findAvailableServers(dataIds, audio) {
        try {
            const response = await axios.get(`${this.baseUrl}/provider/${this.name}/servers`, {
                params: { dataIds, audio },
                timeout: 15000
            });
            return response.data;
        } catch (err) {
            console.error(`API error for ${this.name}.findAvailableServers:`, err.message);
            return [];
        }
    }

    async extractStreamFromLinkId(linkId) {
        try {
            const response = await axios.get(`${this.baseUrl}/provider/${this.name}/stream`, {
                params: { linkId },
                timeout: 30000
            });
            const stream = response.data;
            if (stream && !stream.file && stream.url) {
                stream.file = stream.url;
            }
            if (stream.tracks && Array.isArray(stream.tracks)) {
                for (const track of stream.tracks) {
                    if (!track.file && track.url) {
                        track.file = track.url;
                    }
                }
            }
            return stream;
        } catch (err) {
            console.error(`API error for ${this.name}.extractStreamFromLinkId:`, err.message);
            throw new Error(`failed to extract stream: ${err.message}`);
        }
    }
}

async function fetchProviderList(apiBaseUrl) {
    try {
        const response = await axios.get(`${apiBaseUrl}/status`, { timeout: 5000 });
        const providers = response.data.providers || [];
        return providers.filter(p => p.online).map(p => p.name);
    } catch (err) {
        console.error("failed to fetch provider list from api, using fallback list.");
       return ["Miruro", "Anikoto", "AnimeGG", "AnimeHeaven", "AniDB", "AniDao", "AllAnime", "Animeverse", "AniNeko", "ReAnime", "AniZone", "Nyanime", "Senshi", "Animetsu", "AnimeParadise", "KickAssAnime"];
    }
}

async function createProviders(apiBaseUrl) {
    const providerNames = await fetchProviderList(apiBaseUrl);
    return providerNames.map(name => new ApiProvider(apiBaseUrl, name));
}

async function selectServerTwoStep(providerServersMap, audioLabelText, statusBar) {
    if (providerServersMap.size === 0) return null;
    const providerEntries = Array.from(providerServersMap.entries());
    const providerOptions = providerEntries.map(([prov, servers]) => `${C.bold}${prov.name}${C.reset}  ${C.dim}${servers.length} server${servers.length !== 1 ? 's' : ''}${C.reset}`);
    const providerIdx = await selectMenuOption(providerOptions, `\n  ${C.bold}${C.cyan}◈ select provider${C.reset}  ${C.dim}(${audioLabelText})${C.reset}`, { allowBack: true, statusBar });
    if (providerIdx < 0) return null;
    const [selectedProvider, servers] = providerEntries[providerIdx];
    const serverOptions = servers.map(s => s.name);
    const serverIdx = await selectMenuOption(serverOptions, `\n  ${C.bold}${C.cyan}◈ ${selectedProvider.name}${C.reset}  ${C.dim}select server${C.reset}`, { allowBack: true, statusBar });
    if (serverIdx < 0) return null;
    const selectedServer = servers[serverIdx];
    return { provider: selectedProvider, serverId: selectedServer.id, serverName: selectedServer.name };
}

async function selectEpisodeWithMarkers(maxEpNum, totalEpisodes, title, statusBar, titleMap = new Map()) {
    const watchInfo = getWatchlistInfo(title);
    const lastWatched = watchInfo ? watchInfo.lastEpisode : 0;
    const effectiveTotal = totalEpisodes || watchInfo?.totalEpisodes || null;
    const episodeOptions = [];
    for (let i = 1; i <= maxEpNum; i++) {
        let label = effectiveTotal ? `${C.bold}ep ${i}${C.reset}${C.dim}/${effectiveTotal}${C.reset}` : `${C.bold}ep ${i}${C.reset}`;
        if (effectiveTotal && effectiveTotal > 0) {
            const percent = Math.round((i / effectiveTotal) * 100);
            const filled = Math.round(percent / 10);
            const minibar = `${C.green}${'▰'.repeat(filled)}${C.reset}${C.dim}${'▱'.repeat(10 - filled)}${C.reset}`;
            label += `  [${minibar}] ${C.dim}${percent}%${C.reset}`;
        }
        const epTitle = titleMap.get(i);
        if (epTitle && epTitle.trim()) {
            const shortTitle = epTitle.length > 40 ? epTitle.slice(0, 37) + '...' : epTitle;
            label += `  ${C.dim}${shortTitle}${C.reset}`;
        }
        let marker = "";
        if (i <= lastWatched) marker = `${C.green}✓${C.reset} `;
        else if (i === lastWatched + 1) marker = `${C.yellow}▶${C.reset} `;
        else marker = `${C.dim}·${C.reset} `;
        episodeOptions.push(`${marker}${label}`);
    }
    const pickedEpIdx = await selectMenuOption(episodeOptions, `\n  ${C.bold}${C.cyan}◈ episodes${C.reset}  ${C.dim}${maxEpNum} available${C.reset}`, { allowBack: true, statusBar });
    return pickedEpIdx >= 0 ? pickedEpIdx + 1 : -1;
}

async function showMetadataPanel(title) {
    console.log(`\n  ${C.dim}fetching metadata for${C.reset} ${C.bold}"${title}"${C.reset}...`);
    const metadata = await fetchAnimeMetadata(title);
    if (metadata) {
        const content = [];
        if (metadata.rating) {
            const filled = Math.round(metadata.rating / 2);
            const stars = `${C.yellow}${'★'.repeat(filled)}${C.reset}${C.dim}${'☆'.repeat(5 - filled)}${C.reset}`;
            content.push(`${stars}  ${C.bold}${metadata.rating}${C.reset}${C.dim}/10${C.reset}`);
            content.push('');
        }
        if (metadata.genres && metadata.genres.length) {
            const genreStr = metadata.genres.map(g => `${C.cyan}${g}${C.reset}`).join(`  ${C.dim}·${C.reset}  `);
            content.push(`${C.dim}genres${C.reset}   ${genreStr}`);
        }
        if (metadata.episodes) content.push(`${C.dim}episodes${C.reset} ${C.bold}${metadata.episodes}${C.reset}`);
        if (metadata.status) content.push(`${C.dim}status${C.reset}   ${C.yellow}${metadata.status}${C.reset}`);
        if (metadata.synopsis) {
            content.push('');
            const cleanSynopsis = stripHtmlTags(metadata.synopsis);
            const words = cleanSynopsis.split(' ');
            let line = '';
            for (const word of words) {
                if ((line + ' ' + word).length <= 68) line += (line ? ' ' : '') + word;
                else { content.push(`  ${C.dim}${line}${C.reset}`); line = word; }
            }
            if (line) content.push(`  ${C.dim}${line}${C.reset}`);
        }
        renderBox(title, content, C.green);
    } else {
        renderBox("info", [`no metadata found for "${title}".`], C.dim);
    }
    console.log(`\n  ${C.dim}1 continue  2 back${C.reset}`);
    const answer = await askQuestion(`\n  ${C.bold}${C.yellow}›${C.reset} `);
    if (answer.trim() === '1') return metadata;
    else return null;
}

async function triggerSearchWorkflow(initialQuery, providersList) {
    if (!providersList) providersList = await createProviders(loadSettings().apiBaseUrl);
    clearScreen();
    renderHeader("SEARCH", `${providersList.length} providers ready`);
    const query = initialQuery ?? await askQuestion(`\n  ${C.bold}${C.yellow}›${C.reset} `);
    const payload = query.trim();
    if (!payload) return;
    saveSearchToHistory(payload);

    const globalResults = await withSpinner(`searching across ${providersList.length} providers...`, async () => {
        const results = await Promise.all(providersList.map(async (prov) => {
            try { const hits = await prov.search(payload, loadSettings().defaultAudio === 'dub'); return Array.isArray(hits) ? hits.map(item => ({ provider: prov, item })) : []; } catch(e) { return []; }
        }));
        return results.flat();
    });

    let flattenedMatches = globalResults.map(match => ({ ...match, score: 0 }));
    if (!flattenedMatches.length) { renderBox("no results", [`nothing found for "${payload}"`], C.red); await wait(2000); return; }
    const normalizedQuery = payload.toLowerCase();
    flattenedMatches = flattenedMatches.map(match => {
        let cleanTitle = match.item.title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim();
        match.item.title = cleanTitle;
        const similarity = similarityScore(cleanTitle, normalizedQuery);
        let score = Math.floor(similarity * 100);
        if (cleanTitle.toLowerCase() === normalizedQuery) score = 100;
        return { ...match, score };
    }).filter(match => match.score > 25);
    if (!flattenedMatches.length) { renderBox("no matches", [`no close matches for "${payload}"`], C.red); await wait(2000); return; }
    const groupedMap = {};
    flattenedMatches.forEach(match => { const normalizedKey = match.item.title.toLowerCase(); if (!groupedMap[normalizedKey]) groupedMap[normalizedKey] = []; groupedMap[normalizedKey].push(match); });
    const groupEntries = Object.entries(groupedMap).map(([key, matches]) => ({ key, matches, maxScore: Math.max(...matches.map(m => m.score)) }));
    groupEntries.sort((a, b) => b.maxScore - a.maxScore);
    const topGroups = groupEntries.slice(0, 50);
    const showSelectionStrings = topGroups.map(({ key, matches }) => {
        const item = matches[0].item;
        const uniqueEngines = Array.from(new Set(matches.map(i => i.provider.name)));
        const audioFlags = audioLabel(matches.some(i => i.item.hasSub), matches.some(i => i.item.hasDub));
        const sourceLabel = uniqueEngines.length === 1 ? uniqueEngines[0] : `${uniqueEngines.length} sources`;
        const score = Math.max(...matches.map(m => m.score));
        const scoreBar = score >= 90 ? `${C.green}${score}%${C.reset}` : score >= 70 ? `${C.yellow}${score}%${C.reset}` : `${C.dim}${score}%${C.reset}`;
        return `${padRightVisible(item.title, 44)} ${C.cyan}${audioFlags}${C.reset}  ${C.dim}${sourceLabel}${C.reset}  ${scoreBar}`;
    });
    const idx = await selectMenuOption(showSelectionStrings, `\n  ${C.bold}${C.cyan}◈ results for${C.reset} ${C.bold}"${payload}"${C.reset}`, { allowBack: true, statusBar: { providersCount: providersList.length, apiUrl: loadSettings().apiBaseUrl } });
    if (idx >= 0 && idx < topGroups.length) {
        const selectedGroup = topGroups[idx];
        const selectedTitle = selectedGroup.matches[0].item.title;
        let finalMatches = selectedGroup.matches;
        if (selectedGroup.matches.length > 1) {
            const providerOptions = selectedGroup.matches.map(m => {
                const audioFlags = audioLabel(m.item.hasSub, m.item.hasDub);
                return `${C.bold}${m.provider.name}${C.reset}  ${C.dim}${audioFlags}${C.reset}`;
            });
            const chosenProvIdx = await selectMenuOption(providerOptions, `\n  ${C.bold}${C.cyan}◈ pick provider${C.reset}  ${C.dim}${selectedTitle}${C.reset}`, { allowBack: true });
            if (chosenProvIdx < 0) return;
            finalMatches = [selectedGroup.matches[chosenProvIdx]];
        }
        const showMeta = await selectMenuOption(["view anime details", "go straight to episodes"], `\n  ${C.bold}${C.cyan}◈ ${selectedTitle}${C.reset}`, { allowBack: true });
        if (showMeta === 0) { const metadata = await showMetadataPanel(selectedTitle); if (!metadata) return; }
        else if (showMeta < 0) return;
        await handleAnimeSelection(finalMatches);
    }
}

async function handleAnimeSelection(selectedMatches, startingEpisode, lockedAudio) {
    const settings = loadSettings();
    const coreTitle = selectedMatches[0]?.item.title || "Selected Anime";
    const providersList = await createProviders(settings.apiBaseUrl);
    const statusBar = { providersCount: providersList.length, apiUrl: settings.apiBaseUrl };
    const hasSub = selectedMatches.some(m => m.item.hasSub);
    const hasDub = selectedMatches.some(m => m.item.hasDub);
    let audio = lockedAudio || settings.defaultAudio;
    if (!lockedAudio && hasSub && hasDub && settings.defaultAction !== "download") {
        const audioIdx = await selectMenuOption([`${C.cyan}SUB${C.reset}  subtitled`, `${C.magenta}DUB${C.reset}  dubbed`], `\n  ${C.bold}${C.cyan}◈ audio track${C.reset}  ${C.dim}default: ${settings.defaultAudio.toUpperCase()}${C.reset}`, { allowBack: true, statusBar });
        if (audioIdx === 1) audio = "dub";
        else if (audioIdx < 0) return;
    } else if (!lockedAudio && !hasSub && hasDub) audio = "dub";
    else if (!lockedAudio && hasSub && !hasDub) audio = "sub";

    let isDownloadMode = false;
    let isBatchMode = false;
    if (settings.defaultAction === "ask") {
        const actionIdx = await selectMenuOption(["▶  stream via mpv", "↓  download single episode", "↓↓ batch download episodes"], `\n  ${C.bold}${C.cyan}◈ action${C.reset}`, { allowBack: true, statusBar });
        if (actionIdx < 0) return;
        if (actionIdx === 0) isDownloadMode = false;
        else if (actionIdx === 1) isDownloadMode = true;
        else if (actionIdx === 2) { isDownloadMode = true; isBatchMode = true; }
    } else if (settings.defaultAction === "download") {
        isDownloadMode = true;
        const batchChoice = await selectMenuOption(["single episode", "batch download range"], `\n  ${C.bold}${C.cyan}◈ download mode${C.reset}`, { allowBack: true, statusBar });
        if (batchChoice === 1) isBatchMode = true;
        else if (batchChoice < 0) return;
    }

    let providerEpLists;
    try {
        providerEpLists = await withSpinner(`loading episodes for "${coreTitle}"...`, async () => {
            const lists = await Promise.all(selectedMatches.map(async (m) => {
                try { const list = await m.provider.findEpisodes(m.item.url); return { provider: m.provider, list: Array.isArray(list) ? list : [] }; } catch(e) { return { provider: m.provider, list: [] }; }
            }));
            return lists;
        });
    } catch (err) {
        console.log(`  ${C.yellow}⚠ retrying episode fetch...${C.reset}`);
        providerEpLists = await Promise.all(selectedMatches.map(async (m) => {
            try { const list = await m.provider.findEpisodes(m.item.url); return { provider: m.provider, list: Array.isArray(list) ? list : [] }; } catch(e) { return { provider: m.provider, list: [] }; }
        }));
    }
    const validLists = providerEpLists.filter(p => p.list && p.list.length > 0);
    if (!validLists.length) {
        renderBox("no episodes found", [
            "no episodes returned from any provider.",
            "the api may have changed its response format.",
            "try a different provider or update kittycli."
        ], C.red);
        await wait(3000);
        return;
    }
    let maxEpNum = 0;
    for (const p of validLists) for (const ep of p.list) { let num = ep.number; if (typeof num === 'string') num = parseInt(num, 10); if (typeof num === 'number' && !isNaN(num) && num > maxEpNum) maxEpNum = num; }
    if (maxEpNum === 0) { renderBox("error", ["invalid episode numbers."], C.red); await wait(2000); return; }

    const watchInfo = getWatchlistInfo(coreTitle);
    let effectiveTotalEpisodes = watchInfo?.totalEpisodes ?? null;
    let anilistIdForWorker = watchInfo?.anilistId ?? undefined;
    if (!effectiveTotalEpisodes) {
        const totalData = await fetchTotalEpisodesFromWorker(coreTitle, anilistIdForWorker, settings.apiBaseUrl);
        if (totalData && totalData.totalEpisodes !== undefined && totalData.totalEpisodes !== null) { effectiveTotalEpisodes = totalData.totalEpisodes; anilistIdForWorker = totalData.anilistId || undefined; }
    }

    const titleMap = new Map();
    for (const ep of validLists.flatMap(p => p.list)) { let num = ep.number; if (typeof num === 'string') num = parseInt(num, 10); if (typeof num === 'number' && !isNaN(num) && ep.title) titleMap.set(num, ep.title); }
    let targetEpisode = startingEpisode || 1;
    if (!startingEpisode && !isBatchMode) {
        const picked = await selectEpisodeWithMarkers(maxEpNum, effectiveTotalEpisodes, coreTitle, statusBar, titleMap);
        if (picked === -1) return;
        targetEpisode = picked;
    }

    if (isDownloadMode && isBatchMode) {
        const startEpRaw = await askQuestion(`\n  ${C.yellow}start episode (1–${maxEpNum})${C.reset}  ${C.bold}›${C.reset} `);
        const endEpRaw = await askQuestion(`  ${C.yellow}end episode (–${maxEpNum})${C.reset}  ${C.bold}›${C.reset} `);
        const start = parseInt(startEpRaw.trim(), 10);
        let end = parseInt(endEpRaw.trim(), 10);
        if (isNaN(start) || isNaN(end) || start < 1 || end > maxEpNum || start > end) { renderBox("invalid range", [`use numbers between 1 and ${maxEpNum}`], C.red); await wait(2000); return; }
        const sampleEp = start;
        const sampleProviderServersMap = new Map();
        for (const p of validLists) {
            const epObj = p.list.find(e => { let num = e.number; if (typeof num === 'string') num = parseInt(num, 10); return num === sampleEp; });
            const dataIds = resolveEpisodeDataIds(epObj);
            if (dataIds != null) {
                try { const servers = await p.provider.findAvailableServers(dataIds, audio); if (servers.length) sampleProviderServersMap.set(p.provider, servers.map(s => ({ id: s.id, name: s.name }))); } catch(e) {}
            }
        }
        if (sampleProviderServersMap.size === 0) { renderBox("error", [`no servers for episode ${sampleEp}`], C.red); await wait(2000); return; }
        const selection = await selectServerTwoStep(sampleProviderServersMap, audio === "sub" ? "SUB" : "DUB", statusBar);
        if (!selection) return;
        const { provider: selectedProvider, serverId } = selection;
        const jobs = [];
        for (let ep = start; ep <= end; ep++) jobs.push({ episode: ep, title: titleMap.get(ep) || `Episode ${ep}`, provider: selectedProvider, serverId, serverName: selection.serverName, audio });
        await batchDownloadQueue(jobs, coreTitle, statusBar);
        return;
    }

    if (isDownloadMode) {
        const downloadProviderServersMap = new Map();
        for (const p of validLists) {
            const epObj = p.list.find(e => { let num = e.number; if (typeof num === 'string') num = parseInt(num, 10); return num === targetEpisode; });
            const dataIds = resolveEpisodeDataIds(epObj);
            if (dataIds != null) {
                try { const servers = await p.provider.findAvailableServers(dataIds, audio); if (servers.length) downloadProviderServersMap.set(p.provider, servers.map(s => ({ id: s.id, name: s.name }))); } catch(e) {}
            }
        }
        if (downloadProviderServersMap.size === 0) { renderBox("error", ["no download links found."], C.red); await wait(2000); return; }
        const selection = await selectServerTwoStep(downloadProviderServersMap, audio === "sub" ? "SUB" : "DUB", statusBar);
        if (!selection) return;
        const stream = await withSpinner(`fetching stream from ${selection.provider.name}...`, async () => await selection.provider.extractStreamFromLinkId(selection.serverId));
        if (stream && !stream.file && stream.url) stream.file = stream.url;
        renderBox("stream ready", [stream.file], C.cyan);
        if (stream.tracks && stream.tracks.length > 0) {
            const subChoice = await selectMenuOption(["download subtitles", "skip"], `\n  ${C.bold}subtitles available${C.reset}`, { allowBack: false });
            if (subChoice === 0) {
                for (let i = 0; i < stream.tracks.length; i++) {
                    const sub = stream.tracks[i];
                    const subUrl = sub.file || sub.url;
                    if (!subUrl) continue;
                    let ext = '.srt';
                    if (subUrl) {
                        const match = subUrl.match(/\.(vtt|ass|srt)(\?|$)/i);
                        if (match) ext = '.' + match[1].toLowerCase();
                    }
                    const subPath = path.join(process.cwd(), `${coreTitle} - Episode ${targetEpisode} (${audio.toUpperCase()}).${sub.label || sub.lang || 'sub'}${ext}`);
                    await downloadSubtitle(subUrl, subPath);
                    console.log(`  ${C.green}✓ subtitle saved: ${subPath}${C.reset}`);
                }
            }
        }
        const copyChoice = await selectMenuOption(["copy url to clipboard", "proceed to download"], `\n  ${C.bold}ready${C.reset}`, { allowBack: false });
        if (copyChoice === 0) { const copied = await copyToClipboard(stream.file); if (copied) console.log(`  ${C.green}✓ url copied to clipboard!${C.reset}`); else console.log(`  ${C.red}✗ failed to copy (install xclip on linux)${C.reset}`); }
        const ext = stream.file.includes('.m3u8') ? '.mp4' : (stream.file.match(/\.(mp4|mkv|mov|avi)($|\?)/)?.[1] || 'mp4');
        const filename = `${coreTitle} - Episode ${targetEpisode} (${audio.toUpperCase()}).${ext}`;
        await resumeableDownload(stream, filename);
        return;
    }

    let userWantsToContinue = true, preferredProviderName = null, preferredServerName = null, currentAudio = audio;
    while (targetEpisode <= maxEpNum && userWantsToContinue) {
        const providerServersMap = new Map();
        for (const p of validLists) {
            const epObj = p.list.find(e => { let num = e.number; if (typeof num === 'string') num = parseInt(num, 10); return num === targetEpisode; });
            const dataIds = resolveEpisodeDataIds(epObj);
            if (dataIds != null) {
                try { const servers = await p.provider.findAvailableServers(dataIds, currentAudio); if (servers.length) providerServersMap.set(p.provider, servers.map(s => ({ id: s.id, name: s.name }))); } catch(e) {}
            }
        }
        if (providerServersMap.size === 0) { renderBox("error", [`no servers for episode ${targetEpisode}`], C.red); break; }
        let selectedProvider = null, selectedServerId = null, selectedServerName = null;
        if (preferredProviderName && preferredServerName) {
            for (const [prov, servers] of providerServersMap.entries()) {
                if (prov.name === preferredProviderName) { const matchedServer = servers.find(s => s.name === preferredServerName); if (matchedServer) { selectedProvider = prov; selectedServerId = matchedServer.id; selectedServerName = matchedServer.name; break; } }
            }
            if (!selectedProvider) console.log(`  ${C.yellow}⚠ preferred server unavailable — reselecting${C.reset}`);
        }
        if (!selectedProvider) {
            const selection = await selectServerTwoStep(providerServersMap, currentAudio === "sub" ? "SUB" : "DUB", statusBar);
            if (!selection) { userWantsToContinue = false; break; }
            selectedProvider = selection.provider; selectedServerId = selection.serverId; selectedServerName = selection.serverName;
            preferredProviderName = selectedProvider.name; preferredServerName = selectedServerName;
        }
        if (!selectedProvider || !selectedServerId) { renderBox("error", ["no server selected."], C.red); break; }
        try {
            const stream = await withSpinner(`fetching stream from ${selectedProvider.name}...`, async () => await selectedProvider.extractStreamFromLinkId(selectedServerId));
            if (!stream?.file && !stream?.url) throw new Error("no video file");
            if (stream && !stream.file && stream.url) stream.file = stream.url;
            renderBox("stream ready", [stream.file], C.cyan);
            if (stream.tracks && stream.tracks.length > 0) {
                const subChoice = await selectMenuOption(["download subtitles", "skip"], `\n  ${C.bold}subtitles available${C.reset}`, { allowBack: false });
                if (subChoice === 0) {
                    for (let i = 0; i < stream.tracks.length; i++) {
                        const sub = stream.tracks[i];
                        const subUrl = sub.file || sub.url;
                        if (!subUrl) continue;
                        let ext = '.srt';
                        if (subUrl) {
                            const match = subUrl.match(/\.(vtt|ass|srt)(\?|$)/i);
                            if (match) ext = '.' + match[1].toLowerCase();
                        }
                        const subPath = path.join(process.cwd(), `${coreTitle} - Episode ${targetEpisode} (${currentAudio.toUpperCase()}).${sub.label || sub.lang || 'sub'}${ext}`);
                        await downloadSubtitle(subUrl, subPath);
                        console.log(`  ${C.green}✓ subtitle saved: ${subPath}${C.reset}`);
                    }
                }
            }
            const copyChoice = await selectMenuOption(["copy url to clipboard", "▶ play now"], `\n  ${C.bold}ready${C.reset}`, { allowBack: false });
            if (copyChoice === 0) { const copied = await copyToClipboard(stream.file); if (copied) console.log(`  ${C.green}✓ url copied!${C.reset}`); else console.log(`  ${C.red}✗ copy failed (install xclip on linux)${C.reset}`); await wait(1000); }
            const episodeDisplay = effectiveTotalEpisodes ? `Episode ${targetEpisode}/${effectiveTotalEpisodes}` : `Episode ${targetEpisode}`;
            const epTitle = titleMap.get(targetEpisode);
            const playingTitle = epTitle ? `${episodeDisplay} — ${epTitle}` : episodeDisplay;
            const audioTag = currentAudio === "sub" ? `${C.cyan}SUB${C.reset}` : `${C.magenta}DUB${C.reset}`;
            renderBox("now playing", [
                `${C.bold}${C.green}${coreTitle}${C.reset}`,
                `${C.yellow}${playingTitle}${C.reset}`,
                `${C.dim}${selectedProvider.name}  ·  ${selectedServerName}  ·${C.reset}  ${audioTag}  ${C.dim}·  ${settings.playbackSpeed}x${C.reset}`
            ], C.green);
            saveToWatchlist(coreTitle, targetEpisode, currentAudio, selectedMatches, effectiveTotalEpisodes ?? undefined, anilistIdForWorker);
            await playWithMpv(stream, `${coreTitle} — ${playingTitle}`, settings, coreTitle, targetEpisode, effectiveTotalEpisodes, currentAudio);
            if (targetEpisode < maxEpNum) {
                console.log(`\n  ${C.green}✓ episode ${targetEpisode} done${C.reset}`);
                const nextTitle = titleMap.get(targetEpisode + 1) || "";
                const result = await bingeCountdownWithProgress(settings.bingeCountdownSeconds, targetEpisode + 1, currentAudio, nextTitle, () => { const newAudio = currentAudio === "sub" ? "dub" : "sub"; updateWatchlistAudio(coreTitle, newAudio); }, settings.autoPlayNext);
                if (result.continue) {
                    if (result.newAudio) {
                        currentAudio = result.newAudio;
                        console.log(`  ${C.yellow}◈ switched to ${currentAudio.toUpperCase()}${C.reset}`);
                    }
                    targetEpisode++;
                } else {
                    userWantsToContinue = false;
                }
            } else {
                console.log(`  ${C.green}✓ finished last episode!${C.reset}`);
                break;
            }
        } catch (err) {
            renderBox("playback error", [err.message || err], C.red);
            await wait(2000);
            break;
        }
    }
    console.log(`  ${C.dim}session ended.${C.reset}`);
}

async function triggerQuickResume(providersList) {
    const list = loadWatchlist();
    if (list.length === 0) { renderBox("info", ["watchlist is empty. nothing to resume."], C.dim); await wait(1500); return; }
    const last = list[0];
    const mappedMatches = [];
    for (const match of last.matches) {
        const foundProvider = providersList.find(p => p.name === match.providerName);
        if (foundProvider) mappedMatches.push({ provider: foundProvider, item: { title: last.title, url: match.url, hasSub: match.hasSub, hasDub: match.hasDub } });
    }
    if (mappedMatches.length === 0) { renderBox("error", ["cannot restore provider data for last watch."], C.red); await wait(2000); return; }
    await handleAnimeSelection(mappedMatches, last.lastEpisode + 1, last.audio);
}

async function triggerRecentSearchesWorkflow(providersList) {
    const history = loadSearchHistory();
    if (history.length === 0) {
        clearScreen();
        renderHeader("RECENT SEARCHES", "");
        renderBox("info", ["no searches saved yet."], C.dim);
        await pauseForKey();
        return;
    }
    const options = [...history.map((query, idx) => `${padRightVisible(query, 48)} ${C.dim}#${idx + 1}${C.reset}`), `${C.dim}clear all${C.reset}`, `${C.dim}go back${C.reset}`];
    const selectedIdx = await selectMenuOption(options, `\n  ${C.bold}${C.magenta}◈ recent searches${C.reset}`, { allowBack: true });
    if (selectedIdx < 0 || selectedIdx === history.length + 1) return;
    if (selectedIdx === history.length) { clearSearchHistory(); renderBox("done", ["searches cleared."], C.green); await wait(1200); return; }
    const selectedQuery = history[selectedIdx];
    const actionOptions = [`search  "${selectedQuery}"`, `delete this entry`, `go back`];
    const actionIdx = await selectMenuOption(actionOptions, `\n  ${C.bold}${C.cyan}◈ ${selectedQuery}${C.reset}`, { allowBack: true });
    if (actionIdx === 0) await triggerSearchWorkflow(selectedQuery, providersList);
    else if (actionIdx === 1) { deleteSearchHistoryItem(selectedIdx); renderBox("done", ["search deleted."], C.green); await wait(1000); }
}

async function triggerWatchlistWorkflow(providersList) {
    if (!providersList) providersList = await createProviders(loadSettings().apiBaseUrl);
    const list = loadWatchlist();
    if (list.length === 0) {
        clearScreen();
        renderHeader("WATCHLIST", "");
        renderBox("info", ["watchlist is empty.", "start watching to build your history."], C.dim);
        await wait(2500);
        return;
    }
    const options = list.map((item, idx) => {
        const epDisplay = item.totalEpisodes ? `${C.bold}ep ${item.lastEpisode}${C.reset}${C.dim}/${item.totalEpisodes}${C.reset}` : `${C.bold}ep ${item.lastEpisode}${C.reset}`;
        const audioTag = item.audio === "sub" ? `${C.cyan}SUB${C.reset}` : `${C.magenta}DUB${C.reset}`;
        return `${padRightVisible(item.title, 40)}  ${epDisplay}  ${audioTag}  ${C.dim}${item.timestamp}${C.reset}`;
    });
    options.push(`${C.dim}clear watchlist${C.reset}`, `${C.dim}go back${C.reset}`);
    const selectedIdx = await selectMenuOption(options, `\n  ${C.bold}${C.magenta}◈ watchlist${C.reset}`, { allowBack: true });
    if (selectedIdx < 0) return;
    if (selectedIdx === list.length) {
        const confirm = await selectMenuOption(["yes, clear all", "no, go back"], `\n  ${C.bold}${C.red}clear entire watchlist?${C.reset}`, { allowBack: true });
        if (confirm === 0) { clearWatchlist(); renderBox("done", ["watchlist cleared."], C.green); }
        await wait(1500);
        return;
    }
    if (selectedIdx === list.length + 1) return;
    const targetItem = list[selectedIdx];
    const nextEpNum = targetItem.lastEpisode + 1;
    const totalHint = targetItem.totalEpisodes ? `/${targetItem.totalEpisodes}` : '';
    const actionOptions = [
        `▶  resume  ep ${nextEpNum}${totalHint}`,
        `↺  replay  ep ${targetItem.lastEpisode}${totalHint}`,
        `⏮  start from episode 1`,
        `✎  edit episode progress`,
        `◈  toggle audio  (${targetItem.audio.toUpperCase()})`,
        `✓  mark as completed`,
        `○  mark as unwatched`,
        `⟳  refresh total episodes`,
        `✕  remove from watchlist`,
        `←  go back`
    ];
    const actionIdx = await selectMenuOption(actionOptions, `\n  ${C.bold}${C.cyan}◈ ${targetItem.title}${C.reset}`, { allowBack: true });
    if (actionIdx < 0 || actionIdx === actionOptions.length - 1) return;
    if (actionIdx === 7) {
        const totalData = await fetchTotalEpisodesFromWorker(targetItem.title, targetItem.anilistId, loadSettings().apiBaseUrl);
        if (totalData && totalData.totalEpisodes !== null) {
            const list = loadWatchlist();
            const idx = list.findIndex(item => item.title.toLowerCase() === targetItem.title.toLowerCase());
            if (idx !== -1) {
                list[idx].totalEpisodes = totalData.totalEpisodes;
                if (totalData.anilistId) list[idx].anilistId = totalData.anilistId;
                saveWatchlist(list);
                renderBox("updated", [`total episodes set to ${totalData.totalEpisodes}`], C.green);
            } else { renderBox("error", ["entry not found."], C.red); }
        } else { renderBox("error", ["could not fetch total episodes."], C.red); }
        await wait(1500);
        return;
    }
    if (actionIdx === 8) { deleteWatchlistItem(selectedIdx); renderBox("done", ["removed from watchlist."], C.green); await wait(1200); return; }
    if (actionIdx === 4) { const newAudio = targetItem.audio === "sub" ? "dub" : "sub"; updateWatchlistAudio(targetItem.title, newAudio); renderBox("updated", [`audio switched to ${newAudio.toUpperCase()}`], C.green); await wait(1200); return; }
    if (actionIdx === 5) {
        if (targetItem.totalEpisodes && targetItem.totalEpisodes > 0) {
            updateWatchlistEpisode(targetItem.title, targetItem.totalEpisodes);
            renderBox("done", [`${targetItem.title} marked as completed`], C.green);
        } else {
            const manualEp = await askQuestion(`\n  ${C.yellow}final episode number${C.reset}  ${C.bold}›${C.reset} `);
            const epNum = parseInt(manualEp.trim(), 10);
            if (!isNaN(epNum) && epNum > 0) { updateWatchlistEpisode(targetItem.title, epNum); renderBox("done", [`last episode set to ${epNum}`], C.green); }
            else { renderBox("unchanged", ["no change made."], C.yellow); }
        }
        await wait(1500);
        return;
    }
    if (actionIdx === 6) { updateWatchlistEpisode(targetItem.title, 0); renderBox("updated", [`${targetItem.title} marked as unwatched`], C.green); await wait(1500); return; }
    if (actionIdx === 3) {
        const newEpRaw = await askQuestion(`\n  ${C.yellow}new last watched episode (current: ${targetItem.lastEpisode})${C.reset}  ${C.bold}›${C.reset} `);
        const newEp = parseInt(newEpRaw.trim(), 10);
        if (!isNaN(newEp) && newEp >= 0) { updateWatchlistEpisode(targetItem.title, newEp); renderBox("updated", [`episode progress → ${newEp}`], C.green); }
        else { renderBox("unchanged", ["no change made."], C.yellow); }
        await wait(1500);
        return;
    }
    const mappedMatches = [];
    for (const match of targetItem.matches) {
        const foundProvider = providersList.find(p => p.name === match.providerName);
        if (foundProvider) mappedMatches.push({ provider: foundProvider, item: { title: targetItem.title, url: match.url, hasSub: match.hasSub, hasDub: match.hasDub } });
    }
    if (mappedMatches.length === 0) { renderBox("error", ["failed to restore provider data."], C.red); await wait(2000); return; }
    let startEpisode = 1;
    if (actionIdx === 0) startEpisode = targetItem.lastEpisode + 1;
    else if (actionIdx === 1) startEpisode = targetItem.lastEpisode;
    else if (actionIdx === 2) startEpisode = 1;
    await handleAnimeSelection(mappedMatches, startEpisode, targetItem.audio);
}

async function triggerSettingsWorkflow(providersCount) {
    while (true) {
        const settings = loadSettings();
        const options = [
            `default action    ${C.dim}${settings.defaultAction === "ask" ? "ask every time" : settings.defaultAction === "stream" ? "stream via mpv" : "download to disk"}${C.reset}`,
            `binge countdown   ${C.dim}${settings.bingeCountdownSeconds}s${C.reset}`,
            `default audio     ${C.dim}${settings.defaultAudio === "sub" ? "subtitled (sub)" : "dubbed (dub)"}${C.reset}`,
            `playback speed    ${C.dim}${settings.playbackSpeed}x${C.reset}`,
            `mpv arguments     ${C.dim}${settings.mpvArgs ? `"${settings.mpvArgs}"` : "none"}${C.reset}`,
            `menu page size    ${C.dim}${settings.pageSize} rows${C.reset}`,
            `api base url      ${C.dim}${settings.apiBaseUrl}${C.reset}`,
            `auto-update       ${settings.enableUpdateCheck ? `${C.green}on${C.reset}` : `${C.dim}off${C.reset}`}`,
            `auto-play next    ${settings.autoPlayNext ? `${C.green}on${C.reset}` : `${C.dim}off${C.reset}`}`,
            `discord presence  ${settings.discordEnabled ? `${C.green}on${C.reset}` : `${C.dim}off${C.reset}`}`,
            `discord client id ${C.dim}${settings.discordClientId}${C.reset}`,
            `${C.dim}clear recent searches${C.reset}`,
            `${C.dim}reset all settings${C.reset}`,
            `${C.dim}go back${C.reset}`
        ];
        const idx = await selectMenuOption(options, `\n  ${C.bold}${C.cyan}◈ settings${C.reset}`, { allowBack: true, statusBar: { providersCount, apiUrl: settings.apiBaseUrl } });
        if (idx < 0 || idx === options.length - 1) return;
        if (idx === 0) { const actionIdx = await selectMenuOption(["ask every time", "stream via mpv", "download to disk"], `\n  ${C.bold}${C.cyan}default action${C.reset}`, { allowBack: true }); if (actionIdx >= 0) { settings.defaultAction = actionIdx === 1 ? "stream" : actionIdx === 2 ? "download" : "ask"; saveSettings(settings); } }
        else if (idx === 1) { const values = [3,5,10,15,20,30,45,60,90,120]; const valueIdx = await selectMenuOption(values.map(v => `${v}s`), `\n  ${C.bold}${C.cyan}binge countdown${C.reset}`, { allowBack: true }); if (valueIdx >= 0) { settings.bingeCountdownSeconds = values[valueIdx]; saveSettings(settings); } }
        else if (idx === 2) { const audioOpts = ["sub — subtitled", "dub — dubbed"]; const audioIdx = await selectMenuOption(audioOpts, `\n  ${C.bold}${C.cyan}default audio${C.reset}`, { allowBack: true }); if (audioIdx >= 0) { settings.defaultAudio = audioIdx === 0 ? "sub" : "dub"; saveSettings(settings); } }
        else if (idx === 3) { const speeds = [0.5,0.75,1.0,1.25,1.5,1.75,2.0,2.5,3.0]; const speedIdx = await selectMenuOption(speeds.map(s => `${s}x`), `\n  ${C.bold}${C.cyan}playback speed${C.reset}`, { allowBack: true }); if (speedIdx >= 0) { settings.playbackSpeed = speeds[speedIdx]; saveSettings(settings); } }
        else if (idx === 4) { const newArgs = await askQuestion(`\n  ${C.yellow}mpv arguments${C.reset}  ${C.bold}›${C.reset} `); settings.mpvArgs = newArgs.trim(); saveSettings(settings); renderBox("saved", ["mpv arguments updated."], C.green); await wait(1500); }
        else if (idx === 5) { const values = [8,10,12,15,20]; const valueIdx = await selectMenuOption(values.map(v => `${v} rows`), `\n  ${C.bold}${C.cyan}page size${C.reset}`, { allowBack: true }); if (valueIdx >= 0) { settings.pageSize = values[valueIdx]; saveSettings(settings); } }
        else if (idx === 6) { const newUrl = await askQuestion(`\n  ${C.yellow}api base url${C.reset}  ${C.bold}›${C.reset} `); if (newUrl.trim()) { settings.apiBaseUrl = newUrl.trim(); saveSettings(settings); renderBox("saved", [`api url → ${settings.apiBaseUrl}`], C.green); await wait(1500); } }
        else if (idx === 7) { settings.enableUpdateCheck = !settings.enableUpdateCheck; saveSettings(settings); renderBox("updated", [`auto-update ${settings.enableUpdateCheck ? "enabled" : "disabled"}`], C.green); await wait(1000); }
        else if (idx === 8) { settings.autoPlayNext = !settings.autoPlayNext; saveSettings(settings); renderBox("updated", [`auto-play next: ${settings.autoPlayNext ? "on" : "off"}`], C.green); await wait(1000); }
        else if (idx === 9) { settings.discordEnabled = !settings.discordEnabled; saveSettings(settings); renderBox("updated", [`Discord presence ${settings.discordEnabled ? "enabled" : "disabled"}`], C.green); await wait(1000); }
        else if (idx === 10) {
            const newId = await askQuestion(`\n  ${C.yellow}Discord client ID${C.reset}  ${C.bold}›${C.reset} `);
            if (newId.trim()) { settings.discordClientId = newId.trim(); saveSettings(settings); renderBox("saved", ["client ID updated."], C.green); await wait(1500); }
        }
        else if (idx === 11) { clearSearchHistory(); renderBox("done", ["searches cleared."], C.green); await wait(1000); }
        else if (idx === 12) { saveSettings(defaultSettings); renderBox("done", ["settings reset to defaults."], C.green); await wait(1000); }
    }
}

async function triggerProviderOverviewWorkflow(providersList) {
    if (!providersList) providersList = await createProviders(loadSettings().apiBaseUrl);
    clearScreen();
    renderHeader("PROVIDERS", `${providersList.length} sources`);
    console.log();
    providersList.forEach((provider, idx) => {
        const num = String(idx + 1).padStart(2, "0");
        console.log(`  ${C.dim}${num}${C.reset}  ${C.bold}${C.green}${provider.name}${C.reset}`);
    });
    console.log();
    renderBox("info", [
        "all providers are searched in parallel.",
        `api: ${loadSettings().apiBaseUrl}`
    ], C.dim);
    await pauseForKey();
}

async function showAbout(providersCount, apiUrl) {
    clearScreen();
    renderHeader("KITTYCLI", `v${APP_VERSION}`);
    const content = [
        `${C.bold}${C.green}anime aggregator terminal client${C.reset}`,
        `${C.dim}────────────────────────────────────────${C.reset}`,
        `${C.dim}version${C.reset}    ${C.bold}${APP_VERSION}${C.reset}`,
        `${C.dim}node${C.reset}       ${process.version}`,
        `${C.dim}providers${C.reset}  ${C.cyan}${providersCount}${C.reset}`,
        `${C.dim}api${C.reset}        ${C.yellow}${apiUrl}${C.reset}`,
        `${C.dim}data${C.reset}       ${DATA_DIR}`,
        ``,
        `${C.bold}${C.cyan}features${C.reset}`,
        `  ${C.green}◈${C.reset} multi-provider search & streaming`,
        `  ${C.green}◈${C.reset} watchlist with progress tracking`,
        `  ${C.green}◈${C.reset} resumable downloads (http + hls)`,
        `  ${C.green}◈${C.reset} batch episode downloads`,
        `  ${C.green}◈${C.reset} binge mode with countdown`,
        `  ${C.green}◈${C.reset} fuzzy search ranking`,
        `  ${C.green}◈${C.reset} subtitle download`,
        `  ${C.green}◈${C.reset} anilist metadata panel`,
        `  ${C.green}◈${C.reset} playback speed & mpv args`,
        `  ${C.green}◈${C.reset} clipboard url copy`,
        `  ${C.green}◈${C.reset} Discord Rich Presence with GitHub button`,
        ``,
        `${C.dim}gpl-3.0 · based on anikoto api${C.reset}`
    ];
    renderBox("about", content, C.cyan);
    await pauseForKey();
}

if (process.argv.includes('--version') || process.argv.includes('-v')) { console.log(`kittycli v${APP_VERSION}`); process.exit(0); }
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`kittycli v${APP_VERSION} — anime aggregator terminal client`);
    console.log(''); console.log('usage: kittycli [options]'); console.log('');
    console.log('options:');
    console.log('  -v, --version   show version');
    console.log('  -h, --help      show this help');
    console.log('  -s, --search    search directly');
    console.log('');
    console.log(`data: ~/.kittycli/`); process.exit(0);
}

async function terminalEngine() {
    let settings = loadSettings();
    if (settings.enableUpdateCheck) {
        const latest = await checkForUpdates();
        if (latest) {
            console.log(`\n  ${C.yellow}◈ update available: ${latest}  (current: ${APP_VERSION})${C.reset}`);
            console.log(`  ${C.dim}npm update -g @fampep/kittycli${C.reset}\n`);
            await wait(2000);
        }
    }
    const isApiReachable = await checkApiServer(settings.apiBaseUrl);
    if (!isApiReachable) {
        console.log(`  ${C.yellow}⚠ api server unreachable — open settings to change url${C.reset}`);
        await pauseForKey("press any key to open settings...");
        await triggerSettingsWorkflow(0);
        settings = loadSettings();
        const reachable = await checkApiServer(settings.apiBaseUrl);
        if (!reachable) {
            renderBox("fatal", ["still cannot connect. exiting."], C.red);
            rl.close();
            return;
        }
    }

    const providersList = await createProviders(settings.apiBaseUrl);
    const providersCount = providersList.length;
    while (true) {
        const watchlistCount = loadWatchlist().length;
        const historyCount = loadSearchHistory().length;
        clearScreen();
        renderHeader("KITTYCLI", `v${APP_VERSION}  ·  ${providersCount} providers`);
        const W = 72;
        console.log(`\n  ${C.bold}${C.green}╭${"─".repeat(W)}╮${C.reset}`);
        console.log(`  ${C.bold}${C.green}│${C.reset}  ${C.dim}watchlist${C.reset}  ${C.bold}${watchlistCount}${C.reset} item${watchlistCount !== 1 ? 's' : ''}${" ".repeat(W - 16 - String(watchlistCount).length)}${C.bold}${C.green}│${C.reset}`);
        console.log(`  ${C.bold}${C.green}│${C.reset}  ${C.dim}searches ${C.reset}  ${C.bold}${historyCount}${C.reset} saved${" ".repeat(W - 16 - String(historyCount).length)}${C.bold}${C.green}│${C.reset}`);
        console.log(`  ${C.bold}${C.green}│${C.reset}  ${C.dim}api      ${C.reset}  ${C.yellow}${settings.apiBaseUrl}${C.reset}${" ".repeat(Math.max(0, W - 11 - settings.apiBaseUrl.length))}${C.bold}${C.green}│${C.reset}`);
        console.log(`  ${C.bold}${C.green}│${C.reset}  ${C.dim}discord   ${C.reset}  ${settings.discordEnabled ? `${C.green}● on${C.reset}` : `${C.dim}○ off${C.reset}`}${" ".repeat(W - 16)}${C.bold}${C.green}│${C.reset}`);
        console.log(`  ${C.bold}${C.green}╰${"─".repeat(W)}╯${C.reset}\n`);
        const mainOptions = [
            `${C.bold}search anime${C.reset}            ${C.dim}find & stream anything${C.reset}`,
            `${C.bold}recent searches${C.reset}         ${C.dim}${historyCount} saved${C.reset}`,
            `${C.bold}watchlist${C.reset}               ${C.dim}${watchlistCount} item${watchlistCount !== 1 ? 's' : ''}${C.reset}`,
            `${C.bold}quick resume${C.reset}            ${C.dim}continue last watched${C.reset}`,
            `${C.bold}provider overview${C.reset}       ${C.dim}${providersCount} sources${C.reset}`,
            `${C.bold}settings${C.reset}`,
            `${C.bold}clear screen${C.reset}`,
            `${C.bold}help${C.reset}`,
            `${C.bold}about${C.reset}`,
            `${C.dim}exit${C.reset}`
        ];
        const choiceIdx = await selectMenuOption(mainOptions, ``, { statusBar: { providersCount, apiUrl: settings.apiBaseUrl } });
        if (choiceIdx === 0) await triggerSearchWorkflow(undefined, providersList);
        else if (choiceIdx === 1) await triggerRecentSearchesWorkflow(providersList);
        else if (choiceIdx === 2) await triggerWatchlistWorkflow(providersList);
        else if (choiceIdx === 3) await triggerQuickResume(providersList);
        else if (choiceIdx === 4) await triggerProviderOverviewWorkflow(providersList);
        else if (choiceIdx === 5) await triggerSettingsWorkflow(providersCount);
        else if (choiceIdx === 6) console.clear();
        else if (choiceIdx === 7) await showHelpGuide();
        else if (choiceIdx === 8) await showAbout(providersCount, settings.apiBaseUrl);
        else if (choiceIdx === 9) { rl.close(); clearScreen(); console.log(`\n  ${C.green}✓ goodbye!${C.reset}\n`); break; }
    }
}

process.on('SIGINT', () => { console.log(`\n  ${C.green}✓ goodbye!${C.reset}\n`); try { rl.close(); } catch(e) {} process.exit(0); });
process.on('uncaughtException', (err) => { console.error(`\n  ${C.red}✗ unexpected error:${C.reset}`, err.message); try { rl.close(); } catch(e) {} process.exit(1); });

terminalEngine().catch(err => { console.error(`  ${C.red}✗ fatal:${C.reset}`, err.message ?? err); try { rl.close(); } catch(e) {} process.exit(1); });