#!/usr/bin/env node
/*
 * KittyCLI – Anime aggregator terminal client
 * Copyright (C) 2026 fampep
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 */

import axios from 'axios';
import { spawn, execSync } from 'child_process';
import readline from 'readline';
import path from 'path';
import os from 'os';
import fs from 'fs';

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const C = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    italic: "\x1b[3m",
    underline: "\x1b[4m",
    black: "\x1b[30m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
    bgBlack: "\x1b[40m",
    bgRed: "\x1b[41m",
    bgGreen: "\x1b[42m",
    bgYellow: "\x1b[43m",
    bgBlue: "\x1b[44m",
    bgMagenta: "\x1b[45m",
    bgCyan: "\x1b[46m",
    bgWhite: "\x1b[47m"
};

const APP_VERSION = "1.8.5";
const GITHUB_REPO = "fampep/Kitty-cli";
const VERSION_CHECK_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

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
    enableUpdateCheck: true
};

// ----------------------------- helper functions -----------------------------
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

function loadCache() {
    try {
        if (fs.existsSync(CACHE_PATH)) {
            const raw = fs.readFileSync(CACHE_PATH, 'utf8');
            const cache = JSON.parse(raw);
            const now = Date.now();
            const CACHE_TTL_MS = 10 * 60 * 1000;
            return Array.isArray(cache) ? cache.filter(e => now - e.timestamp < CACHE_TTL_MS) : [];
        }
    } catch(e) {}
    return [];
}

function saveCache(cache) {
    try { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8'); } catch(e) {}
}

function getCachedSearch(query) {
    const cache = loadCache();
    const entry = cache.find(e => e.query.toLowerCase() === query.toLowerCase());
    if (entry && Date.now() - entry.timestamp < 10 * 60 * 1000) return entry.results;
    return null;
}

function setCachedSearch(query, results) {
    const cache = loadCache();
    const existingIdx = cache.findIndex(e => e.query.toLowerCase() === query.toLowerCase());
    const entry = { query, timestamp: Date.now(), results };
    if (existingIdx !== -1) cache[existingIdx] = entry;
    else cache.push(entry);
    saveCache(cache);
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
        enableUpdateCheck: typeof stored.enableUpdateCheck === "boolean" ? stored.enableUpdateCheck : true
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

function clearScreen() { process.stdout.write('\x1b[H\x1b[J'); }
function stripAnsi(value) { return value.replace(/\x1b\[[0-9;]*m/g, ""); }
function visibleLength(value) { return stripAnsi(value).length; }
function padRightVisible(value, width) { return value + " ".repeat(Math.max(0, width - visibleLength(value))); }

function renderBox(title, content, color = C.cyan) {
    const maxLen = Math.max(title.length, ...content.map(l => visibleLength(l))) + 4;
    const top = `${color}┌${"─".repeat(maxLen)}┐${C.reset}`;
    const titleLine = `${color}│${C.reset} ${C.bold}${title}${" ".repeat(maxLen - title.length - 1)}${color}│${C.reset}`;
    const mid = `${color}├${"─".repeat(maxLen)}┤${C.reset}`;
    const bottom = `${color}└${"─".repeat(maxLen)}┘${C.reset}`;
    console.log(top);
    console.log(titleLine);
    console.log(mid);
    for (const line of content) {
        console.log(`${color}│${C.reset} ${line}${" ".repeat(maxLen - visibleLength(line) - 1)}${color}│${C.reset}`);
    }
    console.log(bottom);
}

function renderHeader(title, subtitle) {
    const width = 72;
    const line = "═".repeat(width);
    const center = (value) => {
        const cleanLength = visibleLength(value);
        const left = Math.max(0, Math.floor((width - cleanLength) / 2));
        return " ".repeat(left) + value;
    };
    console.log(`${C.bold}${C.cyan}╔${line}╗${C.reset}`);
    console.log(`${C.bold}${C.cyan}║${C.reset}${center(`${C.green}${title}${C.reset}`)}${C.bold}${C.cyan}║${C.reset}`);
    if (subtitle) console.log(`${C.bold}${C.cyan}║${C.reset}${center(`${C.dim}${subtitle}${C.reset}`)}${C.bold}${C.cyan}║${C.reset}`);
    console.log(`${C.bold}${C.cyan}╚${line}╝${C.reset}`);
}

function renderStatusBar(providersCount, apiUrl, additional) {
    const parts = [
        `KITTYCLI v${APP_VERSION}`,
        `${providersCount} provider${providersCount !== 1 ? 's' : ''}`,
        `API: ${apiUrl}`,
        additional || "[↑/↓] move  [Enter] select  [1-9] quick  [Home/End] jump  [Q/Esc] back  [?] help  [Ctrl+C] exit"
    ];
    const bar = parts.map(p => `${C.dim}${p}${C.reset}`).join("  │  ");
    console.log(`\n${C.dim}${"─".repeat(process.stdout.columns || 80)}${C.reset}`);
    console.log(bar);
}

function normalizeTitle(title) { return title.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim(); }

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

async function pauseForKey(message = "Press any key to continue...") {
    console.log(`\n${C.dim}${message}${C.reset}`);
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
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', '◐', '◓', '◑', '◒'];
    let i = 0;
    const interval = setInterval(() => {
        process.stdout.write(`\r${C.cyan}${frames[i]} ${message}${C.reset}`);
        i = (i + 1) % frames.length;
    }, 80);
    try {
        const result = await task();
        clearInterval(interval);
        process.stdout.write(`\r${C.green}[✔] ${message}${C.reset}\n`);
        return result;
    } catch (err) {
        clearInterval(interval);
        process.stdout.write(`\r${C.red}[✘] ${message}${C.reset}\n`);
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

async function playWithMpv(stream, displayTitle, settings) {
    if (!isMpvAvailable()) {
        renderBox("Error", ["mpv not installed. Cannot play video."], C.red);
        return false;
    }
    return new Promise((resolve) => {
        console.log(`\n${C.cyan}Launching mpv...${C.reset}`);
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
        mpv.on('close', (code) => resolve(code === 0));
        mpv.on('error', (err) => { console.log(`${C.red}mpv error: ${err.message}${C.reset}`); resolve(false); });
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
                    process.stdout.write(`\r${C.cyan}[${bar}] ${percent.toFixed(1)}%${C.reset}`);
                }
            }
        });
        ffmpeg.on('close', (code) => {
            console.log();
            if (code === 0) { console.log(`${C.green}[OK] Download complete!${C.reset}`); resolve(true); }
            else { console.log(`${C.red}[FAIL] ffmpeg failed.${C.reset}`); resolve(false); }
        });
        ffmpeg.on('error', (err) => { console.log(`${C.red}ffmpeg error: ${err.message}${C.reset}`); resolve(false); });
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
                console.log(`${C.yellow}[↻] Resuming interrupted download from ${(partial.downloadedBytes / 1024 / 1024).toFixed(1)} MB${C.reset}`);
            } else {
                fs.unlinkSync(partPath);
                fs.unlinkSync(metaPath);
            }
        } catch(e) {}
    }

    if (!partial) {
        renderBox("Download Location", [downloadPath], C.yellow);
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
        console.log(`${C.magenta}[HLS] HLS stream detected. Using ffmpeg (resume not supported).${C.reset}`);
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
                        const filled = Math.round((pd.downloadedBytes / pd.totalBytes) * 30);
                        const bar = '█'.repeat(filled) + '░'.repeat(30 - filled);
                        process.stdout.write(`\r${C.cyan}[${bar}] ${percent.toFixed(1)}% | ${(pd.downloadedBytes/1024/1024).toFixed(1)}MB / ${(pd.totalBytes/1024/1024).toFixed(1)}MB | ${speed.toFixed(1)} MB/s | ETA: ${eta.toFixed(1)}s${C.reset}`);
                    }
                    lastUpdate = now;
                    lastBytes = pd.downloadedBytes;
                } else if (pd.totalBytes === 0) {
                    process.stdout.write(`\r${C.cyan}Downloaded: ${(pd.downloadedBytes / 1024 / 1024).toFixed(1)} MB${C.reset}`);
                }
                if (pd.downloadedBytes % (1024 * 1024 * 5) < chunk.length) {
                    fs.writeFileSync(metaPath, JSON.stringify(pd, null, 2));
                }
            });

            writer.on('finish', () => {
                console.log();
                fs.renameSync(partPath, downloadPath);
                if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
                console.log(`${C.green}[OK] Download complete!${C.reset}`);
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
        renderBox("Download Error", [err.message], C.red);
        return false;
    }
}

async function batchDownloadQueue(jobs, coreTitle, statusBar) {
    console.log(`\n${C.bold}${C.green}[BATCH] Starting batch download of ${jobs.length} episodes${C.reset}`);
    let successCount = 0, failCount = 0;
    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        console.log(`\n${C.cyan}[${i+1}/${jobs.length}] Downloading Episode ${job.episode}...${C.reset}`);
        try {
            const stream = await withSpinner(`Fetching stream from ${job.provider.name}...`, async () => {
                return await job.provider.extractStreamFromLinkId(job.serverId);
            });
            const ext = stream.file.includes('.m3u8') ? '.mp4' : (stream.file.match(/\.(mp4|mkv|mov|avi)($|\?)/)?.[1] || 'mp4');
            const filename = `${coreTitle} - Episode ${job.episode} (${job.audio.toUpperCase()}).${ext}`;
            const success = await resumeableDownload(stream, filename);
            if (success) successCount++;
            else failCount++;
        } catch (err) {
            console.log(`${C.red}[FAIL] ${err.message}${C.reset}`);
            failCount++;
        }
    }
    console.log(`\n${C.green}[BATCH] Finished: ${successCount} succeeded, ${failCount} failed.${C.reset}`);
    await pauseForKey();
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const askQuestion = (q) => new Promise(res => rl.question(q, res));

async function selectMenuOption(options, title, config = {}) {
    return new Promise((resolve) => {
        if (options.length === 0) { resolve(-1); return; }
        let currentPos = 0, resolved = false;
        const pageSize = config.pageSize ?? loadSettings().pageSize;
        const pageCount = Math.max(1, Math.ceil(options.length / pageSize));
        const canUseRawMode = process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
        if (!canUseRawMode) {
            console.log(title);
            options.forEach((opt, idx) => console.log(`${idx + 1}. ${stripAnsi(opt)}`));
            rl.question(`Choose 1-${options.length}: `, (answer) => {
                const parsed = parseInt(answer.trim(), 10);
                resolve(Number.isInteger(parsed) && parsed >= 1 && parsed <= options.length ? parsed - 1 : 0);
            });
            return;
        }
        const isRaw = process.stdin.isRaw;
        process.stdin.setRawMode(true);
        readline.emitKeypressEvents(process.stdin);
        const renderMenu = () => {
            clearScreen();
            console.log(title);
            const page = Math.floor(currentPos / pageSize);
            const start = page * pageSize;
            const visibleOptions = options.slice(start, start + pageSize);
            visibleOptions.forEach((opt, offset) => {
                const idx = start + offset;
                const numberHint = offset < 9 ? `${offset + 1}` : " ";
                const marker = idx === currentPos ? `${C.bold}${C.green}>${C.reset}` : "  ";
                const prefix = idx === currentPos ? `${C.bold}${C.green}${marker} ${C.reset}${C.bold}${opt}${C.reset}` : `${marker} ${C.dim}${numberHint}.${C.reset} ${opt}`;
                console.log(prefix);
            });
            const footerParts = ["[↑/↓] move", "[Enter] select", "[1-9] quick", "[Home/End] jump"];
            if (pageCount > 1) footerParts.push(`[Page ${page+1}/${pageCount}]`);
            if (config.allowBack) footerParts.push("[Q/Esc] back");
            console.log(`\n${C.dim}${footerParts.join(" | ")}${C.reset}`);
            if (config.statusBar) renderStatusBar(config.statusBar.providersCount, config.statusBar.apiUrl);
        };
        const keyHandler = (_str, key) => {
            if (resolved) return;
            if (key && key.name === '?' && !key.ctrl && !key.meta) {
                showHelpGuide().then(() => renderMenu());
                return;
            }
            const page = Math.floor(currentPos / pageSize);
            const pageStart = page * pageSize;
            const visibleCount = Math.min(pageSize, options.length - pageStart);
            const quickPick = key?.sequence && /^[1-9]$/.test(key.sequence) ? parseInt(key.sequence, 10) - 1 : -1;
            if (quickPick >= 0 && quickPick < visibleCount) {
                currentPos = pageStart + quickPick;
                resolved = true; cleanup(); resolve(currentPos);
            } else if (key.name === 'up') { currentPos = currentPos > 0 ? currentPos - 1 : options.length - 1; renderMenu(); }
            else if (key.name === 'down') { currentPos = currentPos < options.length - 1 ? currentPos + 1 : 0; renderMenu(); }
            else if (key.name === 'left' || key.name === 'pageup') { currentPos = Math.max(0, currentPos - pageSize); renderMenu(); }
            else if (key.name === 'right' || key.name === 'pagedown') { currentPos = Math.min(options.length - 1, currentPos + pageSize); renderMenu(); }
            else if (key.name === 'home') { currentPos = 0; renderMenu(); }
            else if (key.name === 'end') { currentPos = options.length - 1; renderMenu(); }
            else if (key.name === 'return') { resolved = true; cleanup(); resolve(currentPos); }
            else if (config.allowBack && (key.name === 'escape' || key.name === 'q')) { resolved = true; cleanup(); resolve(-1); }
            else if (key.ctrl && key.name === 'c') { cleanup(); process.exit(0); }
        };
        const cleanup = () => { process.stdin.removeListener('keypress', keyHandler); process.stdin.setRawMode(isRaw); };
        renderMenu();
        process.stdin.on('keypress', keyHandler);
    });
}

async function showHelpGuide() {
    clearScreen();
    renderHeader("KITTYCLI GUIDE", `version ${APP_VERSION}`);
    const content = [
        `${C.bold}Navigation${C.reset}`,
        `  [↑/↓]  Move through menus`,
        `  [Enter]  Select`,
        `  [1-9]  Quick pick visible rows`,
        `  [Home/End]  Jump to top/bottom`,
        `  [PageUp/Down]  Change pages`,
        `  [?]  Show this help (anywhere)`,
        ``,
        `${C.bold}Features${C.reset}`,
        `  [SEARCH]  Recent searches (delete single items)`,
        `  [WATCHLIST]  Resume & edit progress`,
        `  [SETTINGS]  Default action, binge timer, page size, audio, mpv args, speed`,
        `  [DOWNLOAD]  Auto-download HLS with progress bar`,
        `  [RESUME]  Resumable downloads (HTTP only)`,
        `  [BATCH]  Batch download episodes (range)`,
        `  [QUICK RESUME]  Last watched`,
        `  [AUDIO TOGGLE]  Press 'A' during binge countdown`,
        `  [COPY URL]  Copy stream URL to clipboard before playback/download`,
        `  [SUBTITLES]  Download when available`,
        `  [METADATA]  Synopsis, rating, genres, total episodes`,
        `  [SMART SEARCH]  Fuzzy search ranking`,
        `  [CACHE]  Search results cached (10 min)`,
        `  [UPDATE CHECK]  Auto-update notification`,
        ``,
        `${C.bold}Player${C.reset}`,
        `  mpv (only player supported)`,
        `  Playback speed control (0.5x - 3.0x)`,
        ``,
        `${C.bold}API Server${C.reset}`,
        `  Current: ${loadSettings().apiBaseUrl}`,
        `  Change in Settings -> API Base URL`
    ];
    renderBox("Help", content, C.cyan);
    return pauseForKey();
}

async function bingeCountdownWithProgress(seconds, nextEpisodeNum, currentAudio, nextEpisodeTitle, onAudioToggle) {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
        console.log(`${C.yellow}Continue to episode ${nextEpisodeNum} (${nextEpisodeTitle})? (Y/n) [auto Y in ${seconds}s]${C.reset}`);
        await wait(seconds * 1000);
        return { continue: true };
    }
    return new Promise((resolve) => {
        let remaining = seconds, resolved = false;
        const isRaw = process.stdin.isRaw;
        process.stdin.setRawMode(true);
        let audio = currentAudio;
        const render = () => {
            const filled = Math.round((remaining / seconds) * 20);
            const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
            const audioIndicator = audio === "sub" ? "SUB" : "DUB";
            const titleDisplay = nextEpisodeTitle ? ` — ${nextEpisodeTitle}` : "";
            process.stdout.write(`\r${C.cyan}[Next] Episode ${nextEpisodeNum}${titleDisplay} in ${remaining}s  [${bar}]  ${C.bold}Y${C.reset}${C.cyan} cont, ${C.bold}N${C.reset}${C.cyan} stop, ${C.bold}A${C.reset}${C.cyan} toggle (${audioIndicator})${C.reset}`);
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
                if (!resolved) { resolved = true; clearInterval(timer); process.stdin.setRawMode(isRaw); process.stdin.removeListener('data', onData); console.log(`\n${C.dim}[STOP] Stopped binge.${C.reset}`); resolve({ continue: false }); }
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
        renderBox("Connection Error", [
            `Cannot connect to API server at ${baseUrl}`,
            "Make sure the server is running and the URL is correct."
        ], C.red);
        return false;
    }
}

// ================================ API‑BASED PROVIDER ================================
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
            return response.data;
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
            return response.data;
        } catch (err) {
            console.error(`API error for ${this.name}.extractStreamFromLinkId:`, err.message);
            throw new Error(`Failed to extract stream: ${err.message}`);
        }
    }
}

async function fetchProviderList(apiBaseUrl) {
    try {
        const response = await axios.get(`${apiBaseUrl}/status`, { timeout: 5000 });
        const providers = response.data.providers || [];
        return providers.filter(p => p.online).map(p => p.name);
    } catch (err) {
        console.error("Failed to fetch provider list from API, using fallback list.");
        return ["Miruro", "Anikoto", "AnimeGG", "AnimeHeaven", "AniDB", "AniDao", "AllAnime", "AniNeko", "ReAnime", "AniZone", "Nyanime"];
    }
}

async function createProviders(apiBaseUrl) {
    const providerNames = await fetchProviderList(apiBaseUrl);
    return providerNames.map(name => new ApiProvider(apiBaseUrl, name));
}

// ----------------------------- workflows (unchanged except for using API providers) -----------------------------
async function selectServerTwoStep(providerServersMap, audioLabelText, statusBar) {
    if (providerServersMap.size === 0) return null;
    const providerEntries = Array.from(providerServersMap.entries());
    const providerOptions = providerEntries.map(([prov, servers]) => `${prov.name} ${C.dim}(${servers.length} server${servers.length !== 1 ? 's' : ''})${C.reset}`);
    const providerIdx = await selectMenuOption(providerOptions, `\n${C.bold}${C.cyan}Select Provider (${audioLabelText})${C.reset}`, { allowBack: true, statusBar });
    if (providerIdx < 0) return null;
    const [selectedProvider, servers] = providerEntries[providerIdx];
    const serverOptions = servers.map(s => s.name);
    const serverIdx = await selectMenuOption(serverOptions, `\n${C.bold}${C.cyan}${selectedProvider.name} – Select Server${C.reset}`, { allowBack: true, statusBar });
    if (serverIdx < 0) return null;
    const selectedServer = servers[serverIdx];
    return { provider: selectedProvider, serverId: selectedServer.id, serverName: selectedServer.name };
}

async function selectEpisodeWithMarkers(maxEpNum, totalEpisodes, title, statusBar) {
    const watchInfo = getWatchlistInfo(title);
    const lastWatched = watchInfo ? watchInfo.lastEpisode : 0;
    const effectiveTotal = totalEpisodes || watchInfo?.totalEpisodes || null;
    const episodeOptions = [];
    for (let i = 1; i <= maxEpNum; i++) {
        let label = effectiveTotal ? `Episode ${i}/${effectiveTotal}` : `Episode ${i}`;
        if (effectiveTotal && effectiveTotal > 0) { const percent = Math.round((i / effectiveTotal) * 100); label += ` ${C.dim}(${percent}%)${C.reset}`; }
        let marker = "";
        if (i <= lastWatched) marker = `${C.green}[X]${C.reset} `;
        else if (i === lastWatched + 1) marker = `${C.yellow}[>]${C.reset} `;
        else marker = `${C.dim}[ ]${C.reset} `;
        episodeOptions.push(`${marker}${label}`);
    }
    const pickedEpIdx = await selectMenuOption(episodeOptions, `\n${C.bold}${C.cyan}Select Episode (${maxEpNum} available)${C.reset}`, { allowBack: true, statusBar });
    return pickedEpIdx >= 0 ? pickedEpIdx + 1 : -1;
}

async function showMetadataPanel(title) {
    console.log(`\n${C.bold}${C.cyan}Fetching metadata for "${title}"...${C.reset}`);
    const metadata = await fetchAnimeMetadata(title);
    if (metadata) {
        const content = [];
        if (metadata.rating) { const stars = '★'.repeat(Math.floor(metadata.rating / 2)) + '☆'.repeat(5 - Math.floor(metadata.rating / 2)); content.push(`${C.yellow}${stars}${C.reset}  ${metadata.rating}/10`); content.push(''); }
        if (metadata.genres && metadata.genres.length) { const genreStr = metadata.genres.map(g => `${C.cyan}${g}${C.reset}`).join(' • '); content.push(`${C.bold}Genres:${C.reset} ${genreStr}`); }
        if (metadata.episodes) content.push(`${C.bold}Episodes:${C.reset} ${metadata.episodes}`);
        if (metadata.status) content.push(`${C.bold}Status:${C.reset} ${metadata.status}`);
        if (metadata.synopsis) {
            content.push(''); content.push(`${C.bold}Synopsis:${C.reset}`);
            const cleanSynopsis = stripHtmlTags(metadata.synopsis);
            const words = cleanSynopsis.split(' ');
            let line = '';
            for (const word of words) { if ((line + ' ' + word).length <= 70) line += (line ? ' ' : '') + word; else { content.push(`  ${line}`); line = word; } }
            if (line) content.push(`  ${line}`);
        }
        renderBox(title, content, C.green);
    } else { renderBox("Info", [`No metadata found for "${title}".`], C.dim); }
    console.log(`\n${C.dim}Press 1 to continue to episodes, 2 to go back...${C.reset}`);
    const answer = await askQuestion(`\n${C.bold}${C.yellow}Choice (1/2):${C.reset} `);
    if (answer.trim() === '1') return metadata;
    else return null;
}

async function triggerSearchWorkflow(initialQuery, providersList) {
    if (!providersList) providersList = await createProviders(loadSettings().apiBaseUrl);
    clearScreen();
    renderHeader("SEARCH ANIME", `${providersList.length} providers ready`);
    const query = initialQuery ?? await askQuestion(`\n${C.bold}${C.yellow}Enter search query:${C.reset} `);
    const payload = query.trim();
    if (!payload) return;
    saveSearchToHistory(payload);
    let globalResults = getCachedSearch(payload);
    if (!globalResults) {
        globalResults = await withSpinner(`Searching "${payload}" on ${providersList.length} providers...`, async () => {
            const results = await Promise.all(providersList.map(async (prov) => {
                try { const hits = await prov.search(payload, loadSettings().defaultAudio === 'dub'); return Array.isArray(hits) ? hits.map(item => ({ provider: prov, item })) : []; } catch(e) { return []; }
            }));
            return results.flat();
        });
        setCachedSearch(payload, globalResults);
    } else console.log(`${C.dim}[CACHE] Using cached results (from <10 min ago)${C.reset}\n`);
    let flattenedMatches = globalResults.map(match => ({ ...match, score: 0 }));
    if (!flattenedMatches.length) { renderBox("No Results", [`No anime found for "${payload}".`], C.red); await wait(2000); return; }
    const normalizedQuery = payload.toLowerCase();
    flattenedMatches = flattenedMatches.map(match => {
        let cleanTitle = match.item.title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim();
        match.item.title = cleanTitle;
        const similarity = similarityScore(cleanTitle, normalizedQuery);
        let score = Math.floor(similarity * 100);
        if (cleanTitle.toLowerCase() === normalizedQuery) score = 100;
        return { ...match, score };
    }).filter(match => match.score > 25);
    if (!flattenedMatches.length) { renderBox("No Relevant Matches", [`No close matches for "${payload}".`], C.red); await wait(2000); return; }
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
        return `${padRightVisible(item.title, 42)} ${C.yellow}${audioFlags}${C.reset} ${C.dim}${sourceLabel} | match ${score}%${C.reset}`;
    });
    const idx = await selectMenuOption(showSelectionStrings, `\n${C.bold}${C.cyan}Matches for "${payload}"${C.reset}`, { allowBack: true, statusBar: { providersCount: providersList.length, apiUrl: loadSettings().apiBaseUrl } });
    if (idx >= 0 && idx < topGroups.length) {
        const selectedTitle = topGroups[idx].matches[0].item.title;
        const showMeta = await selectMenuOption(["View anime details", "Continue to episodes"], `\n${C.bold}${C.cyan}Options for: ${selectedTitle}${C.reset}`, { allowBack: true });
        if (showMeta === 0) { const metadata = await showMetadataPanel(selectedTitle); if (!metadata) return; }
        else if (showMeta < 0) return;
        await handleAnimeSelection(topGroups[idx].matches);
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
        const audioIdx = await selectMenuOption(["Subtitle Track (SUB)", "Voice Over Dubbing (DUB)"], `\n${C.bold}${C.magenta}Select Audio Track (current default: ${settings.defaultAudio.toUpperCase()})${C.reset}`, { allowBack: true, statusBar });
        if (audioIdx === 1) audio = "dub";
        else if (audioIdx < 0) return;
    } else if (!lockedAudio && !hasSub && hasDub) audio = "dub";
    else if (!lockedAudio && hasSub && !hasDub) audio = "sub";

    let isDownloadMode = false;
    let isBatchMode = false;
    if (settings.defaultAction === "ask") {
        const actionIdx = await selectMenuOption(["Stream via MPV", "Download single episode", "Batch download episodes"], `\n${C.bold}${C.cyan}Select Action${C.reset}`, { allowBack: true, statusBar });
        if (actionIdx < 0) return;
        if (actionIdx === 0) isDownloadMode = false;
        else if (actionIdx === 1) isDownloadMode = true;
        else if (actionIdx === 2) { isDownloadMode = true; isBatchMode = true; }
    } else if (settings.defaultAction === "download") {
        isDownloadMode = true;
        const batchChoice = await selectMenuOption(["Single episode", "Batch download"], `\n${C.bold}${C.cyan}Download mode${C.reset}`, { allowBack: true, statusBar });
        if (batchChoice === 1) isBatchMode = true;
        else if (batchChoice < 0) return;
    }

    let providerEpLists;
    try {
        providerEpLists = await withSpinner(`Fetching episodes for "${coreTitle}"...`, async () => {
            const lists = await Promise.all(selectedMatches.map(async (m) => {
                try { const list = await m.provider.findEpisodes(m.item.url); return { provider: m.provider, list: Array.isArray(list) ? list : [] }; } catch(e) { return { provider: m.provider, list: [] }; }
            }));
            return lists;
        });
    } catch (err) {
        console.log(`${C.yellow}[WARN] Episode fetch failed, retrying with fallback...${C.reset}`);
        providerEpLists = await Promise.all(selectedMatches.map(async (m) => {
            try { const list = await m.provider.findEpisodes(m.item.url); return { provider: m.provider, list: Array.isArray(list) ? list : [] }; } catch(e) { return { provider: m.provider, list: [] }; }
        }));
    }
    const validLists = providerEpLists.filter(p => p.list && p.list.length > 0);
    if (!validLists.length) { renderBox("Error", ["No episodes found from any provider.", "Try selecting a different search match or check your API connection."], C.red); await wait(3000); return; }
    let maxEpNum = 0;
    for (const p of validLists) for (const ep of p.list) { let num = ep.number; if (typeof num === 'string') num = parseInt(num, 10); if (typeof num === 'number' && !isNaN(num) && num > maxEpNum) maxEpNum = num; }
    if (maxEpNum === 0) { renderBox("Error", ["Invalid episode numbers."], C.red); await wait(2000); return; }

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
        const picked = await selectEpisodeWithMarkers(maxEpNum, effectiveTotalEpisodes, coreTitle, statusBar);
        if (picked === -1) return;
        targetEpisode = picked;
    }

    if (isDownloadMode && isBatchMode) {
        const startEpRaw = await askQuestion(`\n${C.yellow}Start episode (1-${maxEpNum}):${C.reset} `);
        const endEpRaw = await askQuestion(`${C.yellow}End episode (${startEpRaw}-${maxEpNum}):${C.reset} `);
        const start = parseInt(startEpRaw.trim(), 10);
        let end = parseInt(endEpRaw.trim(), 10);
        if (isNaN(start) || isNaN(end) || start < 1 || end > maxEpNum || start > end) { renderBox("Invalid range", [`Please use numbers between 1 and ${maxEpNum}.`], C.red); await wait(2000); return; }
        const sampleEp = start;
        const sampleProviderServersMap = new Map();
        for (const p of validLists) {
            const epObj = p.list.find(e => { let num = e.number; if (typeof num === 'string') num = parseInt(num, 10); return num === sampleEp; });
            if (epObj?.dataIds) {
                try { const servers = await p.provider.findAvailableServers(epObj.dataIds, audio); if (servers.length) sampleProviderServersMap.set(p.provider, servers.map(s => ({ id: s.id, name: s.name }))); } catch(e) {}
            }
        }
        if (sampleProviderServersMap.size === 0) { renderBox("Error", [`No servers found for episode ${sampleEp}.`], C.red); await wait(2000); return; }
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
            if (epObj?.dataIds) {
                try { const servers = await p.provider.findAvailableServers(epObj.dataIds, audio); if (servers.length) downloadProviderServersMap.set(p.provider, servers.map(s => ({ id: s.id, name: s.name }))); } catch(e) {}
            }
        }
        if (downloadProviderServersMap.size === 0) { renderBox("Error", ["No download links found."], C.red); await wait(2000); return; }
        const selection = await selectServerTwoStep(downloadProviderServersMap, audio === "sub" ? "SUB" : "DUB", statusBar);
        if (!selection) return;
        const stream = await withSpinner(`Fetching stream from ${selection.provider.name}...`, async () => await selection.provider.extractStreamFromLinkId(selection.serverId));
        renderBox("STREAM URL", [stream.file], C.cyan);
        if (stream.tracks && stream.tracks.length > 0) {
            const subChoice = await selectMenuOption(["Download subtitles", "Skip"], `\n${C.bold}Subtitles available${C.reset}`, { allowBack: false });
            if (subChoice === 0) {
                for (let i = 0; i < stream.tracks.length; i++) {
                    const sub = stream.tracks[i];
                    const subPath = path.join(process.cwd(), `${coreTitle} - Episode ${targetEpisode} (${audio.toUpperCase()}).${sub.lang || 'sub'}.srt`);
                    await downloadSubtitle(sub.file, subPath);
                    console.log(`${C.green}[OK] Subtitle saved: ${subPath}${C.reset}`);
                }
            }
        }
        const copyChoice = await selectMenuOption(["Copy URL to clipboard", "Proceed to download"], `\n${C.bold}Stream ready${C.reset}`, { allowBack: false });
        if (copyChoice === 0) { const copied = await copyToClipboard(stream.file); if (copied) console.log(`${C.green}[OK] URL copied to clipboard!${C.reset}`); else console.log(`${C.red}[FAIL] Failed to copy (install xclip on Linux).${C.reset}`); }
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
            if (epObj?.dataIds) {
                try { const servers = await p.provider.findAvailableServers(epObj.dataIds, currentAudio); if (servers.length) providerServersMap.set(p.provider, servers.map(s => ({ id: s.id, name: s.name }))); } catch(e) {}
            }
        }
        if (providerServersMap.size === 0) { renderBox("Error", [`No servers for episode ${targetEpisode}. Stopping.`], C.red); break; }
        let selectedProvider = null, selectedServerId = null, selectedServerName = null;
        if (preferredProviderName && preferredServerName) {
            for (const [prov, servers] of providerServersMap.entries()) {
                if (prov.name === preferredProviderName) { const matchedServer = servers.find(s => s.name === preferredServerName); if (matchedServer) { selectedProvider = prov; selectedServerId = matchedServer.id; selectedServerName = matchedServer.name; break; } }
            }
            if (!selectedProvider) console.log(`${C.yellow}[WARN] Preferred server not available. Re‑select.${C.reset}`);
        }
        if (!selectedProvider) {
            const selection = await selectServerTwoStep(providerServersMap, currentAudio === "sub" ? "SUB" : "DUB", statusBar);
            if (!selection) { userWantsToContinue = false; break; }
            selectedProvider = selection.provider; selectedServerId = selection.serverId; selectedServerName = selection.serverName;
            preferredProviderName = selectedProvider.name; preferredServerName = selectedServerName;
        }
        if (!selectedProvider || !selectedServerId) { renderBox("Error", ["No server selected."], C.red); break; }
        try {
            const stream = await withSpinner(`Fetching stream from ${selectedProvider.name}...`, async () => await selectedProvider.extractStreamFromLinkId(selectedServerId));
            if (!stream?.file) throw new Error("No video file");
            renderBox("STREAM URL", [stream.file], C.cyan);
            if (stream.tracks && stream.tracks.length > 0) {
                const subChoice = await selectMenuOption(["Download subtitles", "Skip"], `\n${C.bold}Subtitles available for this episode${C.reset}`, { allowBack: false });
                if (subChoice === 0) {
                    for (let i = 0; i < stream.tracks.length; i++) {
                        const sub = stream.tracks[i];
                        const subPath = path.join(process.cwd(), `${coreTitle} - Episode ${targetEpisode} (${currentAudio.toUpperCase()}).${sub.lang || 'sub'}.srt`);
                        await downloadSubtitle(sub.file, subPath);
                        console.log(`${C.green}[OK] Subtitle saved: ${subPath}${C.reset}`);
                    }
                }
            }
            const copyChoice = await selectMenuOption(["Copy URL to clipboard", "Play now"], `\n${C.bold}Stream ready${C.reset}`, { allowBack: false });
            if (copyChoice === 0) { const copied = await copyToClipboard(stream.file); if (copied) console.log(`${C.green}[OK] URL copied to clipboard!${C.reset}`); else console.log(`${C.red}[FAIL] Failed to copy (install xclip on Linux).${C.reset}`); await wait(1000); }
            const episodeDisplay = effectiveTotalEpisodes ? `Episode ${targetEpisode}/${effectiveTotalEpisodes}` : `Episode ${targetEpisode}`;
            const epTitle = titleMap.get(targetEpisode);
            const playingTitle = epTitle ? `${episodeDisplay} - ${epTitle}` : episodeDisplay;
            renderBox("NOW PLAYING", [`${C.bold}${coreTitle}${C.reset}`, `${C.yellow}${playingTitle}${C.reset}`, `${C.dim}via ${selectedProvider.name} / ${selectedServerName} (${currentAudio.toUpperCase()})${C.reset}`, `${C.dim}Speed: ${settings.playbackSpeed}x${C.reset}`], C.green);
            saveToWatchlist(coreTitle, targetEpisode, currentAudio, selectedMatches, effectiveTotalEpisodes ?? undefined, anilistIdForWorker);
            await playWithMpv(stream, `${coreTitle} - ${playingTitle}`, settings);
            if (targetEpisode < maxEpNum) {
                console.log(`\n${C.cyan}[OK] Episode ${targetEpisode} finished.${C.reset}`);
                const nextTitle = titleMap.get(targetEpisode + 1) || "";
                const result = await bingeCountdownWithProgress(settings.bingeCountdownSeconds, targetEpisode + 1, currentAudio, nextTitle, () => { const newAudio = currentAudio === "sub" ? "dub" : "sub"; updateWatchlistAudio(coreTitle, newAudio); });
                if (result.continue) { if (result.newAudio) { currentAudio = result.newAudio; console.log(`${C.yellow}[AUDIO] Switched to ${currentAudio.toUpperCase()} for next episodes.${C.reset}`); } targetEpisode++; } else userWantsToContinue = false;
            } else { console.log(`${C.green}[END] Finished last episode!${C.reset}`); break; }
        } catch (err) { renderBox("Playback Error", [err.message || err], C.red); await wait(2000); break; }
    }
    console.log(`${C.cyan}[DONE] Binge session ended.${C.reset}`);
}

async function triggerQuickResume(providersList) {
    const list = loadWatchlist();
    if (list.length === 0) { renderBox("Info", ["Watchlist is empty. Nothing to resume."], C.dim); await wait(1500); return; }
    const last = list[0];
    const mappedMatches = [];
    for (const match of last.matches) {
        const foundProvider = providersList.find(p => p.name === match.providerName);
        if (foundProvider) mappedMatches.push({ provider: foundProvider, item: { title: last.title, url: match.url, hasSub: match.hasSub, hasDub: match.hasDub } });
    }
    if (mappedMatches.length === 0) { renderBox("Error", ["Cannot restore provider data for last watch."], C.red); await wait(2000); return; }
    await handleAnimeSelection(mappedMatches, last.lastEpisode + 1, last.audio);
}

async function triggerRecentSearchesWorkflow(providersList) {
    const history = loadSearchHistory();
    if (history.length === 0) {
        clearScreen();
        renderHeader("RECENT SEARCHES");
        renderBox("Info", ["No searches saved yet."], C.dim);
        await pauseForKey();
        return;
    }
    const options = [...history.map((query, idx) => `${padRightVisible(query, 48)} ${C.dim}#${idx + 1}${C.reset}`), "[ Clear All Searches ]", "[ Go Back ]"];
    const selectedIdx = await selectMenuOption(options, `\n${C.bold}${C.magenta}Recent Searches${C.reset}`, { allowBack: true });
    if (selectedIdx < 0 || selectedIdx === history.length + 1) return;
    if (selectedIdx === history.length) { clearSearchHistory(); renderBox("Done", ["Recent searches cleared."], C.green); await wait(1200); return; }
    const selectedQuery = history[selectedIdx];
    const actionOptions = [`Search "${selectedQuery}"`, `Delete this search`, `Go Back`];
    const actionIdx = await selectMenuOption(actionOptions, `\n${C.bold}${C.cyan}Options for: ${selectedQuery}${C.reset}`, { allowBack: true });
    if (actionIdx === 0) await triggerSearchWorkflow(selectedQuery, providersList);
    else if (actionIdx === 1) { deleteSearchHistoryItem(selectedIdx); renderBox("Done", ["Search deleted."], C.green); await wait(1000); }
}

async function triggerWatchlistWorkflow(providersList) {
    if (!providersList) providersList = await createProviders(loadSettings().apiBaseUrl);
    const list = loadWatchlist();
    if (list.length === 0) {
        clearScreen();
        renderHeader("WATCHLIST");
        renderBox("Info", ["Watchlist is empty.", "Start watching to add to history."], C.dim);
        await wait(2500);
        return;
    }
    const options = list.map((item, idx) => { const epDisplay = item.totalEpisodes ? `Ep ${item.lastEpisode}/${item.totalEpisodes}` : `Ep ${item.lastEpisode}`; return `${padRightVisible(item.title, 42)} ${C.yellow}${epDisplay}${C.reset} ${item.audio.toUpperCase()} ${C.dim}${item.timestamp}${C.reset}`; });
    options.push(`[ Clear Watchlist ]`, `[ Go Back ]`);
    const selectedIdx = await selectMenuOption(options, `\n${C.bold}${C.magenta}WATCHLIST${C.reset}`, { allowBack: true });
    if (selectedIdx < 0) return;
    if (selectedIdx === list.length) {
        const confirm = await selectMenuOption(["Yes, clear watchlist", "No, go back"], `\n${C.bold}${C.red}Clear entire watchlist?${C.reset}`, { allowBack: true });
        if (confirm === 0) { clearWatchlist(); renderBox("Done", ["Watchlist cleared."], C.green); }
        await wait(1500);
        return;
    }
    if (selectedIdx === list.length + 1) return;
    const targetItem = list[selectedIdx];
    const nextEpNum = targetItem.lastEpisode + 1;
    const totalHint = targetItem.totalEpisodes ? `/${targetItem.totalEpisodes}` : '';
    const actionOptions = [`Resume next episode (Ep ${nextEpNum}${totalHint})`, `Replay last episode (Ep ${targetItem.lastEpisode}${totalHint})`, `Start from episode 1`, `Edit episode progress (manual)`, `Change audio preference (current: ${targetItem.audio.toUpperCase()})`, `Mark as completed`, `Mark as unwatched (reset to episode 0)`, `Remove from watchlist`, `Go Back`];
    const actionIdx = await selectMenuOption(actionOptions, `\n${C.bold}${C.cyan}${targetItem.title}${C.reset}`, { allowBack: true });
    if (actionIdx < 0 || actionIdx === 8) return;
    if (actionIdx === 7) { deleteWatchlistItem(selectedIdx); renderBox("Done", ["Removed from watchlist."], C.green); await wait(1200); return; }
    if (actionIdx === 4) { const newAudio = targetItem.audio === "sub" ? "dub" : "sub"; updateWatchlistAudio(targetItem.title, newAudio); renderBox("Updated", [`Audio preference changed to ${newAudio.toUpperCase()}.`], C.green); await wait(1200); return; }
    if (actionIdx === 5) { if (targetItem.totalEpisodes && targetItem.totalEpisodes > 0) { updateWatchlistEpisode(targetItem.title, targetItem.totalEpisodes); renderBox("Completed", [`${targetItem.title} marked as completed.`], C.green); } else { const manualEp = await askQuestion(`\n${C.yellow}Enter final episode number:${C.reset} `); const epNum = parseInt(manualEp.trim(), 10); if (!isNaN(epNum) && epNum > 0) { updateWatchlistEpisode(targetItem.title, epNum); renderBox("Completed", [`Last episode set to ${epNum}.`], C.green); } else { renderBox("Invalid", ["No change made."], C.yellow); } } await wait(1500); return; }
    if (actionIdx === 6) { updateWatchlistEpisode(targetItem.title, 0); renderBox("Updated", [`${targetItem.title} marked as unwatched.`], C.green); await wait(1500); return; }
    if (actionIdx === 3) { const newEpRaw = await askQuestion(`\n${C.yellow}Enter new last watched episode number (current: ${targetItem.lastEpisode}):${C.reset} `); const newEp = parseInt(newEpRaw.trim(), 10); if (!isNaN(newEp) && newEp >= 0) { updateWatchlistEpisode(targetItem.title, newEp); renderBox("Updated", [`Episode progress set to ${newEp}.`], C.green); } else { renderBox("Invalid", ["No change made."], C.yellow); } await wait(1500); return; }
    const mappedMatches = [];
    for (const match of targetItem.matches) { const foundProvider = providersList.find(p => p.name === match.providerName); if (foundProvider) mappedMatches.push({ provider: foundProvider, item: { title: targetItem.title, url: match.url, hasSub: match.hasSub, hasDub: match.hasDub } }); }
    if (mappedMatches.length === 0) { renderBox("Error", ["Failed to restore provider data."], C.red); await wait(2000); return; }
    let startEpisode = 1;
    if (actionIdx === 0) startEpisode = targetItem.lastEpisode + 1;
    else if (actionIdx === 1) startEpisode = targetItem.lastEpisode;
    else if (actionIdx === 2) startEpisode = 1;
    await handleAnimeSelection(mappedMatches, startEpisode, targetItem.audio);
}

async function triggerSettingsWorkflow(providersCount) {
    while (true) {
        const settings = loadSettings();
        const options = [`Default action: ${settings.defaultAction === "ask" ? "Ask every time" : settings.defaultAction === "stream" ? "Stream via MPV" : "Download to disk"}`, `Binge countdown: ${settings.bingeCountdownSeconds}s`, `Default audio: ${settings.defaultAudio === "sub" ? "Subtitled (SUB)" : "Dubbed (DUB)"}`, `Playback speed: ${settings.playbackSpeed}x`, `mpv arguments: ${settings.mpvArgs ? `"${settings.mpvArgs}"` : "(none)"}`, `Menu page size: ${settings.pageSize}`, `API Base URL: ${settings.apiBaseUrl}`, `Auto-update check: ${settings.enableUpdateCheck ? "ON" : "OFF"}`, `Clear recent searches`, `Reset settings`, `Go Back`];
        const idx = await selectMenuOption(options, `\n${C.bold}${C.cyan}Settings${C.reset}`, { allowBack: true, statusBar: { providersCount, apiUrl: settings.apiBaseUrl } });
        if (idx < 0 || idx === options.length - 1) return;
        if (idx === 0) { const actionIdx = await selectMenuOption(["Ask every time", "Stream via MPV", "Download to disk"], `\n${C.bold}${C.cyan}Default Action${C.reset}`, { allowBack: true }); if (actionIdx >= 0) { settings.defaultAction = actionIdx === 1 ? "stream" : actionIdx === 2 ? "download" : "ask"; saveSettings(settings); } }
        else if (idx === 1) { const values = [3,5,10,15,20,30,45,60,90,120]; const valueIdx = await selectMenuOption(values.map(v => `${v} seconds`), `\n${C.bold}${C.cyan}Binge Countdown${C.reset}`, { allowBack: true }); if (valueIdx >= 0) { settings.bingeCountdownSeconds = values[valueIdx]; saveSettings(settings); } }
        else if (idx === 2) { const audioOpts = ["SUB (subtitled)", "DUB (dubbed)"]; const audioIdx = await selectMenuOption(audioOpts, `\n${C.bold}${C.cyan}Default Audio Track${C.reset}`, { allowBack: true }); if (audioIdx >= 0) { settings.defaultAudio = audioIdx === 0 ? "sub" : "dub"; saveSettings(settings); } }
        else if (idx === 3) { const speeds = [0.5,0.75,1.0,1.25,1.5,1.75,2.0,2.5,3.0]; const speedIdx = await selectMenuOption(speeds.map(s => `${s}x`), `\n${C.bold}${C.cyan}Playback Speed${C.reset}`, { allowBack: true }); if (speedIdx >= 0) { settings.playbackSpeed = speeds[speedIdx]; saveSettings(settings); } }
        else if (idx === 4) { const newArgs = await askQuestion(`\n${C.bold}${C.yellow}Enter custom mpv arguments (e.g., --volume=80 --fullscreen):${C.reset} `); settings.mpvArgs = newArgs.trim(); saveSettings(settings); renderBox("Updated", ["mpv arguments saved."], C.green); await wait(1500); }
        else if (idx === 5) { const values = [8,10,12,15,20]; const valueIdx = await selectMenuOption(values.map(v => `${v} rows per page`), `\n${C.bold}${C.cyan}Menu Page Size${C.reset}`, { allowBack: true }); if (valueIdx >= 0) { settings.pageSize = values[valueIdx]; saveSettings(settings); } }
        else if (idx === 6) { const newUrl = await askQuestion(`\n${C.bold}${C.yellow}Enter API Base URL (e.g., http://localhost:3000):${C.reset} `); if (newUrl.trim()) { settings.apiBaseUrl = newUrl.trim(); saveSettings(settings); renderBox("Updated", [`API Base URL changed to ${settings.apiBaseUrl}`, "Next search will use it."], C.green); await wait(1500); } }
        else if (idx === 7) { settings.enableUpdateCheck = !settings.enableUpdateCheck; saveSettings(settings); renderBox("Updated", [`Auto-update check ${settings.enableUpdateCheck ? "enabled" : "disabled"}.`], C.green); await wait(1000); }
        else if (idx === 8) { clearSearchHistory(); renderBox("Done", ["Recent searches cleared."], C.green); await wait(1000); }
        else if (idx === 9) { saveSettings(defaultSettings); renderBox("Done", ["Settings reset to defaults."], C.green); await wait(1000); }
    }
}

async function triggerProviderOverviewWorkflow(providersList) {
    if (!providersList) providersList = await createProviders(loadSettings().apiBaseUrl);
    clearScreen();
    renderHeader("PROVIDERS", `${providersList.length} sources configured`);
    providersList.forEach((provider, idx) => { console.log(`${C.bold}${String(idx + 1).padStart(2, "0")}. ${provider.name}${C.reset}`); });
    renderBox("Info", ["Search runs all providers in parallel and merges matching titles.", `API base URL: ${loadSettings().apiBaseUrl}`], C.dim);
    await pauseForKey();
}

async function showAbout(providersCount, apiUrl) {
    clearScreen();
    renderHeader("KITTYCLI", `version ${APP_VERSION}`);
    const content = [`${C.bold}Anime aggregator terminal client${C.reset}`, `${C.dim}──────────────────────────────────────${C.reset}`, `Version: ${APP_VERSION}`, `Node.js ${process.version}`, `Providers: ${providersCount}`, `API: ${apiUrl}`, `Data: ${DATA_DIR}`, ``, `${C.bold}Features:${C.reset}`, `  • Multi‑provider search & streaming`, `  • Watchlist with progress tracking`, `  • Download episodes (HTTP / HLS)`, `  • Resumable downloads (HTTP)`, `  • Batch download episode ranges`, `  • Persistent search history`, `  • Binge mode with countdown & audio toggle`, `  • Quick resume last watched`, `  • Default audio preference`, `  • Copy stream URL to clipboard`, `  • Custom mpv arguments`, `  • Playback speed control`, `  • Subtitle download`, `  • Anime metadata panel`, `  • Smart fuzzy search`, `  • Search result caching`, `  • Auto-update check`, ``, `${C.bold}Player:${C.reset}`, `  mpv (only player supported)`, ``, `${C.bold}Credits:${C.reset}`, `  Based on Anikoto API`, ``, `${C.dim}Licensed under GPL-3.0${C.reset}`];
    renderBox("About", content, C.cyan);
    await pauseForKey();
}

if (process.argv.includes('--version') || process.argv.includes('-v')) { console.log(`kittycli v${APP_VERSION}`); process.exit(0); }
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`kittycli v${APP_VERSION} - Anime aggregator terminal client`);
    console.log(''); console.log('Usage: kittycli [options]'); console.log('');
    console.log('Options:'); console.log('  -v, --version     Show version number'); console.log('  -h, --help        Show this help message');
    console.log('  -s, --search      Search for an anime directly'); console.log('');
    console.log('Data stored at: ~/.kittycli/'); process.exit(0);
}

async function terminalEngine() {
    let settings = loadSettings();
    if (settings.enableUpdateCheck) {
        const latest = await checkForUpdates();
        if (latest) {
            console.log(`\n${C.yellow}[UPDATE] New version available: ${latest} (current: ${APP_VERSION})${C.reset}`);
            console.log(`${C.dim}Run 'npm update -g kittycli' or visit github.com/${GITHUB_REPO}/releases.${C.reset}\n`);
            await wait(2000);
        }
    }
    const isApiReachable = await checkApiServer(settings.apiBaseUrl);
    if (!isApiReachable) {
        console.log(`${C.yellow}[WARN] Please start the API server first, or change the URL in Settings.${C.reset}`);
        await pauseForKey("Press any key to open settings or Ctrl+C to exit...");
        await triggerSettingsWorkflow(0);
        settings = loadSettings();
        const reachable = await checkApiServer(settings.apiBaseUrl);
        if (!reachable) {
            renderBox("Fatal", ["Still cannot connect. Exiting."], C.red);
            rl.close();
            return;
        }
    }

    const providersList = await createProviders(settings.apiBaseUrl);
    const providersCount = providersList.length;
    while (true) {
        const watchlistCount = loadWatchlist().length;
        const historyCount = loadSearchHistory().length;
        const header = `${C.bold}${C.cyan}╔${"═".repeat(70)}╗${C.reset}\n` +
                       `${C.bold}${C.cyan}║${C.reset}${C.green}${C.bold}              KITTYCLI AGGREGATOR PRO v${APP_VERSION}${C.reset}${C.bold}${C.cyan}               ║${C.reset}\n` +
                       `${C.bold}${C.cyan}╠${"═".repeat(70)}╣${C.reset}\n` +
                       `${C.bold}${C.cyan}║${C.reset}  ${C.dim}├─ ${providersCount} provider${providersCount !== 1 ? 's' : ''} online${C.reset}${" ".repeat(48 - String(providersCount).length)}${C.bold}${C.cyan}║${C.reset}\n` +
                       `${C.bold}${C.cyan}║${C.reset}  ${C.dim}├─ Watchlist: ${watchlistCount} item${watchlistCount !== 1 ? 's' : ''}${C.reset}${" ".repeat(48 - String(watchlistCount).length)}${C.bold}${C.cyan}║${C.reset}\n` +
                       `${C.bold}${C.cyan}║${C.reset}  ${C.dim}├─ Search history: ${historyCount} entry${historyCount !== 1 ? 's' : ''}${C.reset}${" ".repeat(48 - String(historyCount).length)}${C.bold}${C.cyan}║${C.reset}\n` +
                       `${C.bold}${C.cyan}║${C.reset}  ${C.dim}└─ API: ${settings.apiBaseUrl}${C.reset}${" ".repeat(48 - settings.apiBaseUrl.length)}${C.bold}${C.cyan}║${C.reset}\n` +
                       `${C.bold}${C.cyan}╚${"═".repeat(70)}╝${C.reset}`;
        const mainOptions = ["Search For Anime", "Recent Searches", "View Watchlist", "Quick Resume (last watched)", "Provider Overview", "Settings", "Clear Screen", "Help Guide", "About", "Exit"];
        const choiceIdx = await selectMenuOption(mainOptions, header, { statusBar: { providersCount, apiUrl: settings.apiBaseUrl } });
        if (choiceIdx === 0) await triggerSearchWorkflow(undefined, providersList);
        else if (choiceIdx === 1) await triggerRecentSearchesWorkflow(providersList);
        else if (choiceIdx === 2) await triggerWatchlistWorkflow(providersList);
        else if (choiceIdx === 3) await triggerQuickResume(providersList);
        else if (choiceIdx === 4) await triggerProviderOverviewWorkflow(providersList);
        else if (choiceIdx === 5) await triggerSettingsWorkflow(providersCount);
        else if (choiceIdx === 6) console.clear();
        else if (choiceIdx === 7) await showHelpGuide();
        else if (choiceIdx === 8) await showAbout(providersCount, settings.apiBaseUrl);
        else if (choiceIdx === 9) { rl.close(); clearScreen(); console.log(`${C.green}Goodbye!${C.reset}\n`); break; }
    }
}

process.on('SIGINT', () => { console.log(`\n${C.green}Goodbye!${C.reset}\n`); try { rl.close(); } catch(e) {} process.exit(0); });
process.on('uncaughtException', (err) => { console.error(`\n${C.red}Unexpected error:${C.reset}`, err.message); try { rl.close(); } catch(e) {} process.exit(1); });

terminalEngine().catch(err => { console.error(`${C.red}Fatal error:${C.reset}`, err.message ?? err); try { rl.close(); } catch(e) {} process.exit(1); });