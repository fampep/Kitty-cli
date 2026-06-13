import express from 'express';
import NodeCache from 'node-cache';
import * as cheerio from 'cheerio';
import crypto from 'node:crypto';
import compression from 'compression';

const app = express();
const PORT = process.env.PORT || 3000;

const kv = new NodeCache({ stdTTL: 21600, maxKeys: 10000 });
const kvGet = (key) => kv.get(key) ?? null;
const kvPut = (key, value, ttl = 21600) => kv.set(key, value, ttl);

const metadataCache = new Map();
function getMetadataCache(key) { return metadataCache.get(key); }
function setMetadataCache(key, value, ttl = 3600000) {
  metadataCache.set(key, value);
  setTimeout(() => metadataCache.delete(key), ttl);
  return value;
}

const USER_AGENT = "Kittycli";
const ANILIST_URL = "https://graphql.anilist.co";

function sha256(str) {
  return crypto.createHash('sha256').update(typeof str === 'string' ? str : JSON.stringify(str)).digest('hex');
}

const shaCache = new Map();
async function memoizedSha256(str) {
  const s = typeof str === 'string' ? str : JSON.stringify(str);
  if (shaCache.has(s)) return shaCache.get(s);
  const hash = sha256(s);
  shaCache.set(s, hash);
  if (shaCache.size > 2000) {
    const toDelete = [...shaCache.keys()].slice(0, 500);
    toDelete.forEach(k => shaCache.delete(k));
  }
  return hash;
}

async function robustFetch(url, options = {}, retries = 1) {
  const timeout = options.timeout || 10000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    const defaultHeaders = { "User-Agent": USER_AGENT };
    const fetchOptions = {
      ...options,
      headers: { ...defaultHeaders, ...(options.headers || {}) },
      signal: controller.signal,
    };
    try {
      const res = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);
      if (!res.ok && attempt < retries) {
        await new Promise(r => setTimeout(r, Math.min(300 * Math.pow(2, attempt), 3000)));
        continue;
      }
      const text = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        text: async () => text,
        json: async () => JSON.parse(text),
        headers: res.headers,
      };
    } catch (err) {
      clearTimeout(timeoutId);
      if (attempt === retries) throw err;
      const delay = Math.min(500 * Math.pow(2, attempt), 5000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`Failed to fetch ${url}`);
}

const anilistQueryQueue = [];
let anilistQueueTimer = null;
async function flushAnilistQueue() {
  if (anilistQueryQueue.length === 0) return;
  const batch = anilistQueryQueue.splice(0, 5);
  await Promise.all(batch.map(({ resolve, reject, query, variables }) => {
    const cacheKey = `anilist:${query}:${JSON.stringify(variables)}`;
    const cached = kvGet(cacheKey);
    if (cached) return resolve(cached);
    robustFetch(ANILIST_URL, { method: 'POST', headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) })
      .then(res => res.ok ? res.json() : Promise.reject(new Error("AniList query failed")))
      .then(data => {
        const result = data.data || {};
        kvPut(cacheKey, result, 21600);
        resolve(result);
      })
      .catch(reject);
  }));
  if (anilistQueryQueue.length > 0) {
    anilistQueueTimer = setTimeout(flushAnilistQueue, 50);
  }
}
async function anilistQuery(query, variables = {}) {
  const cacheKey = `anilist:${query}:${JSON.stringify(variables)}`;
  const cached = kvGet(cacheKey);
  if (cached) return cached;
  return new Promise((resolve, reject) => {
    anilistQueryQueue.push({ resolve, reject, query, variables });
    if (!anilistQueueTimer) {
      anilistQueueTimer = setTimeout(flushAnilistQueue, 10);
    }
  });
}

class BaseProvider {
  constructor(name) { this.name = name; }
  async search(query, dub) { throw new Error("Not implemented"); }
  async findEpisodes(seriesUrl) { throw new Error("Not implemented"); }
  async findAvailableServers(dataIds, audio) { throw new Error("Not implemented"); }
  async extractStreamFromLinkId(linkId) { throw new Error("Not implemented"); }

  async _cachedSearch(query, dub) {
    const cacheKey = `search:${this.name.toLowerCase()}:${await memoizedSha256(query + ":" + String(dub))}`;
    let cached = kvGet(cacheKey);
    if (cached) return cached;
    cached = getMetadataCache(cacheKey);
    if (cached) return cached;
    const results = await this.search(query, dub);
    kvPut(cacheKey, results, 1800);
    setMetadataCache(cacheKey, results, 1800000);
    return results;
  }

  async _cachedEpisodes(seriesUrl) {
    const cacheKey = `episodes:${this.name.toLowerCase()}:${await memoizedSha256(seriesUrl)}`;
    let cached = kvGet(cacheKey);
    if (cached) return cached;
    cached = getMetadataCache(cacheKey);
    if (cached) return cached;
    const episodes = await this.findEpisodes(seriesUrl);
    kvPut(cacheKey, episodes, 3600);
    setMetadataCache(cacheKey, episodes, 3600000);
    return episodes;
  }
}

class MiruroProvider extends BaseProvider {
  constructor() {
    super("Miruro");
    this.baseUrl = "https://www.miruro.tv";
  }

  async _fetchHtml(url, options = {}) {
    const res = await robustFetch(url, {
      headers: { "User-Agent": USER_AGENT, Referer: this.baseUrl, ...options.headers },
      ...options,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }

  async search(query, dub) {
    let currentUrl = `${this.baseUrl}/search?query=${encodeURIComponent(query)}&sort=POPULARITY_DESC&type=ANIME`;
    const results = [];
    while (true) {
      const html = await this._fetchHtml(currentUrl);
      const $ = cheerio.load(html);
      $('a[title][href*="watch"]').each((_, el) => {
        const href = $(el).attr("href");
        const title = $(el).attr("title").trim();
        if (href && title) {
          results.push({
            title,
            url: this.baseUrl + href,
            hasSub: true,
            hasDub: true,
          });
        }
      });
      const nextLink = $('a:contains("Next Page")').attr("href");
      if (!nextLink) break;
      currentUrl = this.baseUrl + nextLink;
    }
    if (dub) return results.filter(r => r.hasDub);
    return results;
  }

  async findEpisodes(seriesUrl) {
    const html = await this._fetchHtml(seriesUrl);
    const $ = cheerio.load(html);
    const episodes = [];
    const container = $("#episodes-list-container");
    if (!container.length) return [];
    container.find("button").each((_, btn) => {
      const title = $(btn).attr("title")?.trim() || "";
      const link = $(btn).find("a").attr("href");
      if (!link) return;
      const match = link.match(/ep-(\d+)/i);
      const number = match ? parseInt(match[1], 10) : 0;
      if (number === 0) return;
      episodes.push({
        dataIds: JSON.stringify({ animeUrl: seriesUrl, episodeUrl: this.baseUrl + link, number }),
        number,
        title: title || `Episode ${number}`,
      });
    });
    return episodes.sort((a, b) => a.number - b.number);
  }

  async findAvailableServers(dataIds, audio) {
    const { animeUrl } = JSON.parse(dataIds);
    const html = await this._fetchHtml(animeUrl);
    const $ = cheerio.load(html);
    const servers = [];
    const select = $("select").first();
    if (!select.length) return servers;
    select.find("option").each((_, opt) => {
      const value = $(opt).attr("value");
      const text = $(opt).text().trim().toLowerCase();
      if (!value) return;
      if (audio === "sub" && text.includes("sub")) {
        servers.push({ id: JSON.stringify({ animeUrl, serverValue: value, audio }), name: `Miruro - ${text}` });
      } else if (audio === "dub" && text.includes("dub")) {
        servers.push({ id: JSON.stringify({ animeUrl, serverValue: value, audio }), name: `Miruro - ${text}` });
      } else if (audio === "sub" && !text.includes("dub") && !text.includes("sub")) {
        servers.push({ id: JSON.stringify({ animeUrl, serverValue: value, audio }), name: `Miruro - ${text}` });
      }
    });
    return servers;
  }

  async extractStreamFromLinkId(linkId) {
    const { episodeUrl } = JSON.parse(linkId);
    const html = await this._fetchHtml(episodeUrl);
    const $ = cheerio.load(html);
    const source = $("source").first();
    if (!source.length) throw new Error("No source element found");
    const proxyUrl = source.attr("src");
    if (!proxyUrl) throw new Error("No src attribute");
    const urlObj = new URL(proxyUrl, this.baseUrl);
    const encoded = urlObj.searchParams.get("url");
    if (!encoded) throw new Error("No url parameter");
    const m3u8Url = decodeURIComponent(encoded);
    return { headers: { Referer: this.baseUrl }, file: m3u8Url, tracks: [] };
  }
}

class AnikotoProvider extends BaseProvider {
  constructor() {
    super("Anikoto");
    this.baseUrl = "https://anikototv.to";
    this.mirrors = ["https://anikototv.to", "https://anikoto.cz", "https://anikoto.me", "https://anikoto.net", "https://anikototv.se"];
    this.cache = {};
  }
  async resolveBase() {
    const all = [...new Set([this.baseUrl, ...this.mirrors].map(u => u.replace(/\/+$/, "")))];
    if (this.cache.base && all.includes(this.cache.base)) {
      try { if ((await robustFetch(this.cache.base, { method: "HEAD", timeout: 5000 })).ok) return this.cache.base; } catch {}
    }
    const winner = await Promise.any(
      all.map(c => robustFetch(c, { method: "HEAD", timeout: 5000 }).then(r => { if (!r.ok) throw new Error(); return c; }))
    ).catch(() => null);
    const base = winner || all[0];
    this.cache.base = base;
    this.baseUrl = base;
    return base;
  }
  pageHeaders() { return { Referer: `${this.baseUrl}/` }; }
  ajaxHeaders() { return { Referer: `${this.baseUrl}/`, "X-Requested-With": "XMLHttpRequest" }; }
  async search(query, dub) {
    await this.resolveBase();
    const res = await robustFetch(`${this.baseUrl}/filter?keyword=${encodeURIComponent(query)}`, { headers: this.pageHeaders() });
    if (!res.ok) return [];
    const $ = cheerio.load(await res.text());
    const results = [];
    $("div.item").each((_, card) => {
      const titleLink = $(card).find("a.name.d-title").first();
      if (!titleLink.length) return;
      const href = titleLink.attr("href") || $(card).find(".ani.poster.tip a").first().attr("href");
      if (!href) return;
      const seriesUrl = this.seriesUrl(href);
      const title = (titleLink.text() || titleLink.attr("data-jp") || $(card).find("img").first().attr("alt") || "").trim();
      if (!title) return;
      const hasDub = $(card).find(".ep-status.dub").length > 0;
      if (dub && !hasDub) return;
      results.push({ title, url: seriesUrl, hasDub, hasSub: $(card).find(".ep-status.sub").length > 0 });
    });
    return results;
  }
  async findEpisodes(seriesUrl) {
    await this.resolveBase();
    const page = await robustFetch(seriesUrl, { headers: this.pageHeaders() });
    if (!page.ok) return [];
    const html = await page.text();
    const $ = cheerio.load(html);
    let seriesId = $("#watch-main").first().attr("data-id") || $("[id*='watch'][data-id]").first().attr("data-id") || "";
    if (!seriesId) {
      const m = html.match(/data-id="(\d+)"/);
      if (m) seriesId = m[1];
    }
    if (!seriesId) return [];
    const listRes = await robustFetch(`${this.baseUrl}/ajax/episode/list/${seriesId}`, { headers: this.ajaxHeaders() });
    const listJson = await listRes.json();
    const $list = cheerio.load(listJson.result || "");
    const episodes = [];
    let epNodes = $list("ul.ep-range li > a");
    if (!epNodes.length) epNodes = $list(".ep-range a");
    epNodes.each((i, a) => {
      const dataIds = $list(a).attr("data-ids");
      if (!dataIds) return;
      const num = parseInt($list(a).attr("data-num") || "", 10);
      const number = isNaN(num) ? i + 1 : num;
      let trueTitle = $list(a).find("span.d-title").first().text().trim() || $list(a).attr("title") || "";
      if (trueTitle) trueTitle = trueTitle.replace(new RegExp(`^\\s*ep(isode)?\\s*${number}\\s*(-|\\s|:)*`, "i"), "").trim();
      episodes.push({ dataIds, number, title: trueTitle || "" });
    });
    return episodes.sort((a,b) => a.number - b.number);
  }
  async findAvailableServers(dataIds, audio) {
    await this.resolveBase();
    const res = await robustFetch(`${this.baseUrl}/ajax/server/list?servers=${encodeURIComponent(dataIds)}`, { headers: this.ajaxHeaders() });
    const html = (await res.json()).result || "";
    const $ = cheerio.load(html);
    const servers = [];
    const groups = audio === "dub" ? ["dub"] : ["sub", "hsub"];
    groups.forEach(groupType => {
      $(`.servers .type[data-type="${groupType}"] li[data-link-id]`).each((_, el) => {
        const id = $(el).attr("data-link-id") || "";
        const name = $(el).text().trim() || `Server-${id}`;
        if (id) servers.push({ id, name: `${name} (${groupType.toUpperCase()})` });
      });
    });
    return servers;
  }
  async extractStreamFromLinkId(linkId) {
    await this.resolveBase();
    const psRes = await robustFetch(`${this.baseUrl}/ajax/server?get=${encodeURIComponent(linkId)}`, { headers: this.ajaxHeaders() });
    const embedUrl = (await psRes.json())?.result?.url;
    if (!embedUrl) throw new Error("No embed URL");
    const origin = new URL(embedUrl).origin;
    const embedRes = await robustFetch(embedUrl, { headers: { Referer: `${this.baseUrl}/` } });
    const ehtml = await embedRes.text();
    const $ = cheerio.load(ehtml);
    let pId = $("#megaplay-player").first().attr("data-id");
    if (!pId) {
      const m = ehtml.match(/data-id="([^"]+)"/);
      if (m) pId = m[1];
    }
    if (!pId) throw new Error("Player ID not found");
    const srcRes = await robustFetch(`${origin}/stream/getSources?id=${encodeURIComponent(pId)}`, {
      headers: { Referer: embedUrl, "X-Requested-With": "XMLHttpRequest" }
    });
    const data = await srcRes.json();
    const file = Array.isArray(data.sources) ? data.sources[0]?.file : data.sources.file;
    if (!file) throw new Error("No video source");
    return { headers: { Referer: `${origin}/`, Origin: origin }, file, tracks: data.tracks || [] };
  }
  seriesUrl(href) {
    let u = href.startsWith("http") ? href : `${this.baseUrl}${href}`;
    return u.split('?')[0].split('#')[0].replace(/\/ep-[^/]+\/?$/i, "");
  }
}

class AnimeGGProvider extends BaseProvider {
  constructor() { super("AnimeGG"); this.base = "https://www.animegg.org"; }

  // Last path segment of the series URL, used to build "{slug}-episode-{N}" (matches the reference).
  _slug(seriesUrl) {
    const clean = (seriesUrl || "").split("#")[0].split("?")[0].replace(/\/+$/, "");
    return clean.split("/").pop();
  }

  _abs(url) {
    if (!url) return null;
    if (url.startsWith("//")) return "https:" + url;
    if (/^https?:\/\//i.test(url)) return url;
    return this.base + (url.startsWith("/") ? url : "/" + url);
  }

  // Step 1 (reference): search ".moose.page .mse", title from <h2>, href from the result anchor.
  async search(query, dub) {
    if (dub) return [];
    const res = await robustFetch(`${this.base}/search/?q=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    const $ = cheerio.load(await res.text());
    const results = [];
    let cards = $(".moose.page .mse");
    if (!cards.length) cards = $(".mse"); // fallback if the wrapper markup differs
    cards.each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const title = $(el).find("h2").first().text().trim();
      if (!title) return;
      results.push({ title, url: this._abs(href), hasSub: true, hasDub: false });
    });
    return results;
  }

  // The reference builds episode URLs straight from the slug ("{slug}-episode-{N}"), so we just
  // need the set of episode numbers. Collect them from the "-episode-N" links on the series page.
  async findEpisodes(seriesUrl) {
    const res = await robustFetch(seriesUrl);
    if (!res.ok) return [];
    const html = await res.text();
    const slug = this._slug(seriesUrl);
    const numbers = new Set();
    const $ = cheerio.load(html);
    $('a[href*="-episode-"]').each((_, a) => {
      const m = ($(a).attr("href") || "").match(/-episode-(\d+(?:\.\d+)?)/i);
      if (m) numbers.add(parseFloat(m[1]));
    });
    // Fallback: scan the raw HTML for the same pattern if no anchors matched.
    if (!numbers.size) {
      for (const m of html.matchAll(/-episode-(\d+(?:\.\d+)?)/gi)) numbers.add(parseFloat(m[1]));
    }
    return [...numbers].sort((a, b) => a - b).map(number => ({
      dataIds: JSON.stringify({ slug, number }),
      number,
      title: `Episode ${number}`,
    }));
  }

  // Steps 2-3 (reference): build "{base}/{slug}-episode-{N}", then read the embed iframe from
  // ".tab-content.embed-responsive iframe" and form "{base}/embed/{embedId}".
  async findAvailableServers(dataIds, audio) {
    const { slug, number } = JSON.parse(dataIds);
    const episodeUrl = `${this.base}/${slug}-episode-${number}`;
    const res = await robustFetch(episodeUrl, { headers: { Referer: this.base } });
    if (!res.ok) return [];
    const $ = cheerio.load(await res.text());
    let embedSrc = $(".tab-content.embed-responsive iframe").attr("src");
    if (!embedSrc) embedSrc = $("iframe[src]").first().attr("src"); // fallback
    if (!embedSrc) return [];
    const embedId = this._abs(embedSrc).split("/").pop();
    const embedUrl = `${this.base}/embed/${embedId}`;
    return [{ id: JSON.stringify({ embedUrl, referer: episodeUrl }), name: "AnimeGG" }];
  }

  // The reference stops at the embed URL; here we go one step further and pull the playable
  // file out of the embed page so the KittyAPI /stream proxy has a real video to serve.
  async extractStreamFromLinkId(linkId) {
    const { embedUrl, referer } = JSON.parse(linkId);
    const res = await robustFetch(embedUrl, { headers: { Referer: referer || this.base } });
    if (!res.ok) throw new Error("Failed to fetch embed page");
    const html = await res.text();
    const host = new URL(embedUrl).origin;

    const sourceMatch = html.match(/var\s+videoSources\s*=\s*(\[[\s\S]*?\]);?/);
    if (sourceMatch) {
      const sources = [];
      for (const obj of sourceMatch[1].match(/\{[\s\S]*?\}/g) || []) {
        const file = obj.match(/['"]?file['"]?\s*:\s*['"]([^'"]+)['"]/)?.[1];
        if (!file) continue;
        const label = obj.match(/['"]?label['"]?\s*:\s*['"]([^'"]+)['"]/)?.[1] || "";
        sources.push({ file: file.replace(/\\\//g, "/"), label });
      }
      if (sources.length) {
        const best = sources.find(s => /\.m3u8/i.test(s.file))
          || sources.reduce((a, b) => ((parseInt(b.label) || 0) > (parseInt(a.label) || 0) ? b : a));
        return { headers: { Referer: host + "/", Origin: host }, file: this._abs(best.file), tracks: [] };
      }
    }
    // Fallback to the embed URL itself (the reference's raw output).
    return { headers: { Referer: this.base, Origin: this.base }, file: embedUrl, tracks: [] };
  }
}

class AnimeHeavenProvider extends BaseProvider {
  constructor() { super("AnimeHeaven"); this.base = "https://animeheaven.me"; }
  async search(query, dub) {
    if (dub) return [];
    const res = await robustFetch(`${this.base}/search.php?s=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    const html = await res.text();
    const results = [];
    const regex = /<div class='similarimg'>.*?<a href='(anime\.php\?.*?)'><img.*?alt='(.*?)'/gs;
    let match;
    while ((match = regex.exec(html)) !== null) {
      results.push({
        title: match[2].replace(/&#039;/g, "'"),
        url: `${this.base}/${match[1]}`,
        hasSub: true, hasDub: false
      });
    }
    return results;
  }
  async findEpisodes(seriesUrl) {
    const res = await robustFetch(seriesUrl);
    if (!res.ok) return [];
    const html = await res.text();
    const regex = /onclick='gatea\("([a-f0-9]+)"\)'[\s\S]*?<div class='watch2 bc\s*'>(\d+)<\/div>/g;
    const episodes = [];
    let match;
    while ((match = regex.exec(html)) !== null) {
      episodes.push({ dataIds: match[1], number: parseInt(match[2], 10), title: `Episode ${match[2]}` });
    }
    return episodes.sort((a,b) => a.number - b.number);
  }
  async findAvailableServers(dataIds, audio) {
    if (audio !== "sub") return [];
    return [{ id: JSON.stringify({ gateKey: dataIds }), name: "AnimeHeaven Server" }];
  }
  async extractStreamFromLinkId(linkId) {
    const { gateKey } = JSON.parse(linkId);
    const res = await robustFetch(`${this.base}/gate.php`, { headers: { Cookie: `key=${gateKey}`, Referer: this.base } });
    const html = await res.text();
    let videoUrl = html.match(/<source[^>]+src=['"]([^'"]+\.mp4[^'"]*)['"]/i)?.[1]
      || html.match(/href='(https?:\/\/ax\.animeheaven\.me\/video\.mp4\?[^']+)'/)?.[1]
      || (() => { const m = html.match(/video\.mp4\?([a-f0-9]+)&([a-f0-9]+)/); return m ? `https://ax.animeheaven.me/video.mp4?${m[1]}&${m[2]}` : null; })();
    if (!videoUrl) throw new Error("Video URL not found");
    return { headers: { Referer: this.base, Origin: this.base }, file: videoUrl, tracks: [] };
  }
}

class AniDBProvider extends BaseProvider {
  constructor() { super("AniDB"); this.base = "https://anidb.app"; }
  async search(query, dub) {
    const slug = `/browse?q=${encodeURIComponent(query)}&sort=order_popular&page=1`;
    const res = await robustFetch(this.base + slug, { headers: this._getHeaders() });
    if (!res.ok) throw new Error(`Search request failed: ${res.status}`);
    const $ = cheerio.load(await res.text());
    const results = [];
    $(".anime-grid a").each((_, el) => {
      const name = $(el).find("p").first().text().trim();
      const link = $(el).attr("href");
      if (name && link) {
        results.push({
          title: name,
          url: link.startsWith("http") ? link : this.base + link,
          hasSub: true, hasDub: true,
        });
      }
    });
    if (!results.length) throw new Error(`No anime found for "${query}"`);
    return results;
  }
  async findEpisodes(seriesUrl) {
    const animeIdMatch = seriesUrl.match(/-(\d+)$/);
    if (!animeIdMatch) throw new Error(`Cannot extract anime ID from ${seriesUrl}`);
    const animeId = animeIdMatch[1];
    const detailRes = await robustFetch(seriesUrl, { headers: this._getHeaders() });
    if (!detailRes.ok) throw new Error(`Detail page fetch failed: ${detailRes.status}`);
    const $ = cheerio.load(await detailRes.text());
    const animeType = $(".badge.badge-orange").first().text().toUpperCase();
    const isMovie = animeType === "MOVIE";
    const apiRes = await robustFetch(`${this.base}/api/frontend/anime/${animeId}/episodes`, { headers: { ...this._getHeaders(), Accept: "application/json" } });
    if (!apiRes.ok) throw new Error(`Episodes API failed: ${apiRes.status}`);
    const data = await apiRes.json();
    if (!data.episodes?.length) throw new Error("No episodes found");
    const episodes = [];
    if (isMovie) {
      const ep = data.episodes[0];
      episodes.push({ dataIds: JSON.stringify({ episodeId: String(ep.id), animeId }), number: 1, title: "Movie" });
    } else {
      for (let i = 0; i < data.episodes.length; i++) {
        const ep = data.episodes[i];
        episodes.push({ dataIds: JSON.stringify({ episodeId: String(ep.id), animeId }), number: i + 1, title: ep.title || `Episode ${i + 1}` });
      }
    }
    return episodes;
  }
  async findAvailableServers(dataIds, audio) {
    const { episodeId, animeId } = JSON.parse(dataIds);
    const langRes = await robustFetch(`${this.base}/api/frontend/episode/${episodeId}/languages`, { headers: { ...this._getHeaders(), Accept: "application/json" } });
    if (!langRes.ok) throw new Error(`Languages request failed: ${langRes.status}`);
    const data = await langRes.json();
    if (!data.languages?.length) throw new Error("No language streams found");
    const neededCode = audio === "dub" ? "eng" : "jpn";
    const langEntry = data.languages.find(l => l.code === neededCode);
    if (!langEntry) throw new Error(`No ${audio} stream available`);
    return [{
      id: JSON.stringify({ episodeId, animeId, embedUrl: langEntry.embed_url, audio }),
      name: `AniDB ${audio.toUpperCase()} (${langEntry.name || langEntry.code})`,
    }];
  }
  async extractStreamFromLinkId(linkId) {
    const { embedUrl } = JSON.parse(linkId);
    if (!embedUrl) throw new Error("No embed URL in linkId");
    const embedRes = await robustFetch(embedUrl, { headers: this._getHeaders() });
    if (!embedRes.ok) throw new Error(`Embed fetch failed: ${embedRes.status}`);
    const embedHtml = await embedRes.text();
    const startKey = "file: '";
    const endKey = "', type:";
    const start = embedHtml.indexOf(startKey);
    if (start === -1) throw new Error("Could not find 'file:' pattern in embed");
    const valueStart = start + startKey.length;
    const valueEnd = embedHtml.indexOf(endKey, valueStart);
    if (valueEnd === -1) throw new Error("Could not find end of file URL");
    const streamUrl = embedHtml.substring(valueStart, valueEnd);
    if (!streamUrl) throw new Error("Extracted stream URL is empty");
    return { headers: { Origin: this.base, Referer: this.base + "/" }, file: streamUrl, tracks: [] };
  }
  async getStats() {
    const cacheKey = 'anidb:stats';
    const cached = kvGet(cacheKey);
    if (cached) return cached;
    try {
      const [browseRes, homeRes] = await Promise.all([
        robustFetch(`${this.base}/browse`, { headers: this._getHeaders(), timeout: 10000 }),
        robustFetch(this.base, { headers: this._getHeaders(), timeout: 10000 }),
      ]);
      let totalAnimes = null;
      if (browseRes.ok) {
        const $ = cheerio.load(await browseRes.text());
        const resultsText = $('h1 + div p:contains("results")').text() || $('.text-muted:contains("results")').first().text();
        const match = resultsText.match(/([\d,]+)\s+results/);
        if (match) totalAnimes = parseInt(match[1].replace(/,/g, ''), 10);
      }
      let totalAiring = null;
      if (homeRes.ok) {
        const $ = cheerio.load(await homeRes.text());
        const airingLink = $('a[href*="status=Currently+Airing"]').first();
        if (airingLink.length) {
          const airingText = airingLink.find('p').first().text();
          const match = airingText.match(/(\d+)/);
          if (match) totalAiring = parseInt(match[1], 10);
        }
      }
      const result = { totalAnimes, totalAiring };
      kvPut(cacheKey, result, 1800);
      return result;
    } catch (err) {
      console.error(`[AniDB] Failed to fetch stats: ${err.message}`);
      return { totalAnimes: null, totalAiring: null };
    }
  }
  _getHeaders() {
    return {
      Referer: this.base,
      Origin: this.base,
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    };
  }
}

class SenshiProvider extends BaseProvider {
  constructor() { super("Senshi"); this.base = "https://senshi.live"; }
  async search(query, dub) {
    const data = await this._postJson("/anime/filter", {
      searchTerm: query, page: "1", limit: "30", sortBy: "score_desc"
    });
    const results = [];
    for (const item of data.data) {
      const formatted = this._formatAnime(item);
      results.push({ title: formatted.name, url: this._buildAnimeUrl(formatted.link), hasSub: true, hasDub: true });
    }
    if (!results.length) throw new Error(`No anime found for "${query}"`);
    return results;
  }
  async findEpisodes(seriesUrl) {
    const animeId = this._extractAnimeId(seriesUrl);
    if (!animeId) throw new Error(`Cannot extract anime ID from ${seriesUrl}`);
    const detail = await this._getJson(`/anime/${animeId}`);
    const type = detail.type;
    const episodesData = await this._getJson(`/episodes/${animeId}`);
    const episodes = [];
    if (type === "Movie") {
      episodes.push({ dataIds: JSON.stringify({ animeId, episodeId: "1" }), number: 1, title: "Movie" });
    } else {
      for (let i = 0; i < episodesData.length; i++) {
        const ep = episodesData[i];
        const epNumber = ep.ep_id;
        const epTitle = ep.ep_title ? `E${epNumber}: ${ep.ep_title}` : `E${epNumber}`;
        episodes.push({ dataIds: JSON.stringify({ animeId, episodeId: String(epNumber) }), number: epNumber, title: epTitle });
      }
    }
    return episodes;
  }
  async findAvailableServers(dataIds, audio) {
    const { animeId, episodeId } = JSON.parse(dataIds);
    const streams = await this._getJson(`/episode-embeds/${animeId}/${episodeId}`);
    if (!streams.length) throw new Error("No video streams found");
    return streams.map(stream => ({
      id: JSON.stringify({ url: stream.url, headers: this._getHeaders() }),
      name: `Senshi - ${stream.status}`
    }));
  }
  async extractStreamFromLinkId(linkId) {
    const { url, headers } = JSON.parse(linkId);
    if (!url) throw new Error("No stream URL in linkId");
    return { file: url, headers, tracks: [] };
  }
  async _postJson(path, body) {
    const res = await robustFetch(this.base + path, {
      method: "POST",
      headers: { ...this._getHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
    return res.json();
  }
  async _getJson(path) {
    const res = await robustFetch(this.base + path, { headers: this._getHeaders() });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    return res.json();
  }
  _formatAnime(item) {
    const anime = item.anime || item;
    const name = anime.title_english || anime.title;
    return { name, link: anime.public_id };
  }
  _buildAnimeUrl(animeId) { return `${this.base}/watch/${animeId}/1`; }
  _extractAnimeId(urlOrId) {
    if (/^\d+$/.test(urlOrId)) return urlOrId;
    const match = urlOrId.match(/\/(?:watch|anime)\/(\d+)/);
    return match ? match[1] : null;
  }
  _getHeaders() {
    return { Referer: this.base, Origin: this.base, "User-Agent": USER_AGENT, Accept: "application/json, text/plain, */*" };
  }
}

class AnimetsuProvider extends BaseProvider {
  constructor() {
    super("Animetsu");
    this.baseUrl = "https://animetsu.bz";
    this.proxyBase = "https://swiftstream.top/proxy";
    this.apiBase = `${this.baseUrl}/v2/api/anime`;
    this.titlePref = "english";
  }
  _getHeaders(url = this.baseUrl) { return { Referer: url, "User-Agent": USER_AGENT, Accept: "application/json, text/plain, */*" }; }
  _proxyUrl(url) { return `${this.proxyBase}${url}`; }
  async _requestJson(slug) {
    const res = await robustFetch(`${this.apiBase}${slug}`, { headers: this._getHeaders(this.baseUrl) });
    if (!res.ok) throw new Error(`Animetsu API error: ${res.status}`);
    return res.json();
  }
  async search(query, dub) {
    const data = await this._requestJson(`/search/?query=${encodeURIComponent(query)}&sort=popularity&page=1&per_page=20`);
    const results = [];
    for (const item of data.results || []) {
      const romaji = item.title.romaji;
      const pref = item.title[this.titlePref];
      const title = pref && pref !== romaji ? pref : romaji;
      results.push({ title, url: String(item.id), hasSub: true, hasDub: true });
    }
    return results;
  }
  async findEpisodes(seriesUrl) {
    const id = seriesUrl;
    const info = await this._requestJson(`/info/${id}`);
    const eps = await this._requestJson(`/eps/${id}`);
    const isMovie = info.format === "MOVIE";
    return eps.map(ep => ({
      dataIds: JSON.stringify({ id, epNum: ep.ep_num, isMovie, title: info.title?.[this.titlePref] || info.title?.romaji }),
      number: ep.ep_num,
      title: ep.name ? `E${ep.ep_num} : ${ep.name}` : `E${ep.ep_num}`,
    })).sort((a,b) => a.number - b.number);
  }
  async findAvailableServers(dataIds, audio) {
    const { id, epNum } = JSON.parse(dataIds);
    const token = `${id}/${epNum}`;
    const serverList = ["pahe", "kite", "meg", "dio", "kiss", "baku"];
    const settled = await Promise.allSettled(serverList.map(async serverName => {
      const url = `${this.apiBase}/oppai/${token}?server=${serverName}&source_type=${audio}`;
      const res = await robustFetch(url, { headers: this._getHeaders(this.baseUrl) });
      if (!res.ok) return [];
      const data = await res.json();
      let subtitles = [];
      if (["kite", "dio", "baku"].includes(serverName)) {
        subtitles = (data.subs || []).map(sub => ({ file: this._proxyUrl(sub.url), label: sub.lang || "Unknown", kind: "subtitles", default: false }));
      }
      return (data.sources || []).filter(src => src.url).map(src => ({
        id: JSON.stringify({ url: this._proxyUrl(src.url), headers: this._getHeaders(), subtitles }),
        name: `${serverName.toUpperCase()} - ${src.quality || "Auto"} (${audio.toUpperCase()})`,
      }));
    }));
    const servers = settled.flatMap(r => r.status === "fulfilled" ? r.value : []);
    if (!servers.length) throw new Error(`No streams found for ${audio}`);
    return servers;
  }
  async extractStreamFromLinkId(linkId) {
    const { url, headers, subtitles } = JSON.parse(linkId);
    if (!url) throw new Error("No stream URL");
    return { file: url, headers, tracks: subtitles || [] };
  }
}

class AnimeParadiseProvider extends BaseProvider {
  constructor() { super("AnimeParadise"); this.base = "https://animeparadise.moe"; this.apiBase = "https://api.animeparadise.moe"; this.proxyBase = "https://stream.animeparadise.moe/"; }
  async _extractFromUrl(path) {
    const res = await robustFetch(this.base + path, { headers: { "User-Agent": USER_AGENT, Referer: this.base } });
    if (!res.ok) throw new Error(`Failed to fetch ${path}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const nextData = $("#__NEXT_DATA__").text();
    if (!nextData) throw new Error("No __NEXT_DATA__ found");
    return JSON.parse(nextData).props.pageProps;
  }
  async _requestAPI(slug) {
    const res = await robustFetch(`${this.apiBase}/${slug}`, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  }
  async _extractStreams(streamLink) {
    const proxyUrl = this.proxyBase + "m3u8?url=" + streamLink;
    const streams = [{ url: proxyUrl, quality: "Auto" }];
    try {
      const res = await robustFetch(proxyUrl, { headers: { "User-Agent": USER_AGENT, Referer: this.base } });
      if (res.ok) {
        const body = await res.text();
        const lines = body.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith("#EXT-X-STREAM-INF:")) {
            const resolutionMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
            if (resolutionMatch) {
              const m3u8Url = lines[i + 1]?.trim();
              if (m3u8Url) streams.push({ url: this.proxyBase + m3u8Url, quality: resolutionMatch[1] });
            }
          }
        }
      }
    } catch {}
    return streams;
  }
  async search(query, dub) {
    const data = await this._requestAPI(`search?q=${encodeURIComponent(query)}`);
    const list = data.data || [];
    return list.map(item => ({ title: item.title, url: item.link, hasSub: true, hasDub: true }));
  }
  async findEpisodes(seriesUrl) {
    let slug = seriesUrl;
    if (slug.startsWith(this.base)) slug = slug.replace(this.base, "");
    if (!slug.startsWith("/anime/")) slug = `/anime/${slug}`;
    const pageProps = await this._extractFromUrl(slug);
    const animeId = pageProps.data._id;
    const epData = await this._requestAPI(`anime/${animeId}/episode`);
    const episodesRaw = epData.data || [];
    const chapters = episodesRaw.map(ep => ({
      dataIds: JSON.stringify({ uid: ep.uid, origin: ep.origin, animeId }),
      number: ep.number,
      title: ep.title ? `E${ep.number}: ${ep.title}` : `E${ep.number}`,
    }));
    return chapters.reverse();
  }
  async findAvailableServers(dataIds, audio) {
    const { uid, origin } = JSON.parse(dataIds);
    const pageProps = await this._extractFromUrl(`/watch/${uid}?origin=${origin}`);
    const streamLink = pageProps.episode.streamLink;
    if (!streamLink) throw new Error("No stream link found");
    const streams = await this._extractStreams(streamLink);
    const subtitles = (pageProps.episode.subData || []).map(sub => ({
      file: `${this.apiBase}/stream/file/${sub.src}`,
      label: sub.label,
      kind: "subtitles",
      default: false,
    }));
    return streams.map(stream => ({
      id: JSON.stringify({ url: stream.url, subtitles, headers: { Referer: this.base, Origin: this.base } }),
      name: `AnimeParadise - ${stream.quality} (${audio.toUpperCase()})`,
    }));
  }
  async extractStreamFromLinkId(linkId) {
    const { url, subtitles, headers } = JSON.parse(linkId);
    if (!url) throw new Error("No stream URL");
    return { file: url, headers, tracks: subtitles };
  }
}

class AniDaoProvider extends BaseProvider {
  constructor() { super("AniDao"); this.base = "https://anidao.to"; }
  async search(query, dub) {
    const res = await robustFetch(`${this.base}/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    const html = await res.text();
    const results = [];
    const cardRegex = /<article class="an-anime-card">([\s\S]*?)<\/article>/g;
    let match;
    while ((match = cardRegex.exec(html)) !== null) {
      const card = match[1];
      const hrefMatch = card.match(/<a class="an-anime-card__image"[^>]+href="([^"]+)"/);
      const titleMatch = card.match(/<a class="an-anime-card__image"[^>]+title="([^"]+)"/);
      if (hrefMatch && titleMatch) {
        results.push({ title: titleMatch[1].trim(), url: this.base + hrefMatch[1], hasSub: true, hasDub: true });
      }
    }
    return results;
  }
  async findEpisodes(seriesUrl) {
    const res = await robustFetch(seriesUrl);
    if (!res.ok) return [];
    const html = await res.text();
    const episodes = [];
    const rowRegex = /<article class="an-episode-row">([\s\S]*?)<\/article>/g;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const row = match[1];
      const hrefMatch = row.match(/<a class="an-episode-row__thumb"[^>]+href="([^"]+)"/);
      const titleMatch = row.match(/<h3 class="an-episode-row__title"><a[^>]+>([^<]+)<\/a>/);
      if (!hrefMatch) continue;
      const epUrl = this.base + hrefMatch[1];
      const epTitle = titleMatch ? titleMatch[1].trim() : "";
      const numberMatch = hrefMatch[1].match(/episode-(\d+)$/i);
      const number = numberMatch ? parseInt(numberMatch[1], 10) : 0;
      if (number === 0) continue;
      episodes.push({ dataIds: epUrl, number, title: epTitle || `Episode ${number}` });
    }
    const deduped = [];
    const seenNumbers = new Set();
    for (const ep of episodes) {
      if (!seenNumbers.has(ep.number)) {
        seenNumbers.add(ep.number);
        deduped.push(ep);
      }
    }
    return deduped.sort((a,b) => a.number - b.number);
  }
  async findAvailableServers(dataIds, audio) {
    const servers = [];
    const suffix = audio === "sub" ? "SUB" : "DUB";
    servers.push(
      { id: JSON.stringify({ episodeUrl: dataIds, serverKey: `HD-2 ${suffix}` }), name: `HD-2 ${suffix}` },
      { id: JSON.stringify({ episodeUrl: dataIds, serverKey: `StreamHG ${suffix}` }), name: `StreamHG ${suffix}` },
      { id: JSON.stringify({ episodeUrl: dataIds, serverKey: `Earnvids ${suffix}` }), name: `Earnvids ${suffix}` }
    );
    return servers;
  }
  unPack(code) {
    const regex = /eval\(function\(p,a,c,k,e,(?:r|d)\)\{[\s\S]*?\}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/;
    const match = code.match(regex);
    if (!match) return null;
    let p = match[1];
    const a = parseInt(match[2], 10);
    const c = parseInt(match[3], 10);
    const k = match[4].split('|');
    const e = (n) => (n < a ? '' : e(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
    for (let i = c - 1; i >= 0; i--) if (k[i]) p = p.replace(new RegExp('\\b' + e(i) + '\\b', 'g'), k[i]);
    return p.replace(/\\'/g, "'").replace(/\\"/g, '"');
  }
  async extractStreamFromLinkId(linkId) {
    const { episodeUrl, serverKey } = JSON.parse(linkId);
    const epRes = await robustFetch(episodeUrl);
    if (!epRes.ok) throw new Error("Failed to fetch episode page");
    const html = await epRes.text();
    const serverBtnMap = {
      "HD-2 SUB": ["hsub-2", "sub-2"], "HD-2 DUB": ["dub-2"],
      "StreamHG SUB": ["hsub-3", "sub-3"], "StreamHG DUB": ["dub-3"],
      "Earnvids SUB": ["hsub-4", "sub-4"], "Earnvids DUB": ["dub-4"]
    };
    const btnKeys = serverBtnMap[serverKey];
    if (!btnKeys) throw new Error(`Unknown server: ${serverKey}`);
    let embedUrl = null;
    for (const key of btnKeys) {
      const btnRegex = new RegExp(`data-an-server-btn="${key}"[^>]+data-an-video="([^"]+)"`, "i");
      const btnRegex2 = new RegExp(`data-an-video="([^"]+)"[^>]+data-an-server-btn="${key}"`, "i");
      const match = html.match(btnRegex) || html.match(btnRegex2);
      if (match) { embedUrl = match[1]; break; }
    }
    if (!embedUrl) throw new Error(`No embed URL found for server: ${serverKey}`);
    const embedRes = await robustFetch(embedUrl, { headers: { Referer: this.base } });
    const embedHtml = await embedRes.text();
    let videoUrl = null;
    let headers = { Referer: this.base, Origin: this.base };
    if (embedUrl.includes("vibeplayer.site")) {
      const srcMatch = embedHtml.match(/src\s*=\s*["']([^"']+\.m3u8[^"']*)['"]/i) || embedHtml.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)['"]/);
      if (srcMatch) videoUrl = srcMatch[1];
    } else if (embedUrl.includes("otakuhg.site") || embedUrl.includes("otakuvid.online")) {
      const unpacked = this.unPack(embedHtml);
      if (unpacked) {
        const m3u8Match = unpacked.match(/"(?:hls2|hls3|hls4|hls)":\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
        if (m3u8Match) videoUrl = m3u8Match[1];
        else { const anyM3u8 = unpacked.match(/(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/); if (anyM3u8) videoUrl = anyM3u8[1]; }
        if (embedUrl.includes("otakuvid.online")) headers = { Referer: embedUrl };
      }
    }
    if (!videoUrl) throw new Error(`Could not extract stream from ${embedUrl}`);
    return { headers, file: videoUrl, tracks: [] };
  }
}

const ALLANIME_HEX_MAP = {
  "79":"A","7a":"B","7b":"C","7c":"D","7d":"E","7e":"F","7f":"G","70":"H","71":"I","72":"J","73":"K","74":"L","75":"M","76":"N","77":"O","68":"P","69":"Q","6a":"R","6b":"S","6c":"T","6d":"U","6e":"V","6f":"W","60":"X","61":"Y","62":"Z","59":"a","5a":"b","5b":"c","5c":"d","5d":"e","5e":"f","5f":"g","50":"h","51":"i","52":"j","53":"k","54":"l","55":"m","56":"n","57":"o","48":"p","49":"q","4a":"r","4b":"s","4c":"t","4d":"u","4e":"v","4f":"w","40":"x","41":"y","42":"z","08":"0","09":"1","0a":"2","0b":"3","0c":"4","0d":"5","0e":"6","0f":"7","00":"8","01":"9","15":"-","16":".","67":"_","46":"~","02":":","17":"/","07":"?","1b":"#","63":"[","65":"]","78":"@","19":"!","1c":"$","1e":"&","10":"(","11":")","12":"*","13":"+","14":",","03":";","05":"=","1d":"%"
};
function decodeAllanimeUrl(encoded) {
  if (encoded.startsWith("--")) encoded = encoded.slice(2);
  let result = "";
  for (let i = 0; i < encoded.length; i += 2) result += ALLANIME_HEX_MAP[encoded.slice(i,i+2)] || encoded.slice(i,i+2);
  return result.replace(/\\u002F/gi, "/").replace(/\\\|/g, "");
}
const ALLANIME_KEY = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode("Xot36i3lK3:v1")));
async function decodeTobeparsed(blob) {
  try {
    const buf = Uint8Array.from(atob(blob), c=>c.charCodeAt(0));
    const iv12 = buf.slice(1,13);
    const iv16 = new Uint8Array(16);
    iv16.set(iv12); iv16.set([0,0,0,2],12);
    const ct = buf.slice(13, buf.length-16);
    const key = await crypto.subtle.importKey('raw', ALLANIME_KEY, { name: 'AES-CTR' }, false, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-CTR', counter: iv16, length: 128 }, key, ct);
    const plain = new TextDecoder().decode(decrypted);
    const sources = [];
    for (const chunk of plain.split(/[{}]/)) {
      const urlMatch = chunk.match(/"sourceUrl"\s*:\s*"(--[^"]+)"/);
      const nameMatch = chunk.match(/"sourceName"\s*:\s*"([^"]+)"/);
      const prioMatch = chunk.match(/"priority"\s*:\s*([0-9.]+)/);
      if (urlMatch) sources.push({ sourceUrl: urlMatch[1], sourceName: nameMatch?.[1] || "", priority: prioMatch ? parseFloat(prioMatch[1]) : 0 });
    }
    return sources;
  } catch { return []; }
}
async function parseEpisodeSourceUrls(body) {
  const tbMatch = body.match(/"tobeparsed"\s*:\s*"([^"]+)"/);
  if (tbMatch) { const sources = await decodeTobeparsed(tbMatch[1]); if (sources.length) return sources; }
  try { return JSON.parse(body)?.data?.episode?.sourceUrls; } catch { return null; }
}
const PROVIDER_PRIORITY = ["S-mp4","Luf-Mp4","Yt-mp4","Default","Sl-Hls"];
async function trySourceUrls(sourceUrls) {
  const decoded = sourceUrls.filter(s => s.sourceUrl?.startsWith("--")).map(s => ({ sourceName: s.sourceName || "", priority: s.priority || 0, path: decodeAllanimeUrl(s.sourceUrl).replace("/clock", "/clock.json") })).sort((a,b) => (PROVIDER_PRIORITY.indexOf(a.sourceName)||99) - (PROVIDER_PRIORITY.indexOf(b.sourceName)||99));
  for (const src of decoded) {
    let fetchUrl = src.path;
    if (fetchUrl.startsWith("//")) fetchUrl = "https:" + fetchUrl;
    else if (fetchUrl.startsWith("/")) fetchUrl = "https://allanime.day" + fetchUrl;
    else if (!fetchUrl.startsWith("http")) fetchUrl = "https://allanime.day/" + fetchUrl;
    try {
      if (fetchUrl.includes("fast4speed.rsvp") || src.sourceName === "Yt-mp4") {
        const finalUrl = await followRedirects(fetchUrl).catch(() => null);
        if (!finalUrl) continue;
        let isGoogleVideoHost = false;
        try { const host = new URL(finalUrl).hostname.toLowerCase(); isGoogleVideoHost = host === "googlevideo.com" || host.endsWith(".googlevideo.com"); } catch {}
        if (/\.(mp4|webm|mkv|m3u8)(\?|$)/i.test(finalUrl) || isGoogleVideoHost || (!finalUrl.includes("youtube.com/watch") && !finalUrl.includes("youtu.be/"))) {
          return { ok: true, url: finalUrl, resolution: "?", sourceName: src.sourceName, isDirectMp4: !finalUrl.includes(".m3u8"), referer: "https://allmanga.to" };
        }
        continue;
      }
      const linkRes = await robustFetch(fetchUrl, { headers: { Referer: "https://allmanga.to" } });
      if (!linkRes.ok) continue;
      const linkJson = await linkRes.json();
      const links = linkJson?.links;
      if (!links?.length) continue;
      const allLinks = links.filter(l => l.link);
      const mp4Links = allLinks.filter(l => !l.link.includes(".m3u8") && !l.link.includes("master."));
      const best = (mp4Links.length ? mp4Links : allLinks).sort((a,b) => (parseInt(b.resolutionStr)||0) - (parseInt(a.resolutionStr)||0))[0];
      if (!best) continue;
      return { ok: true, url: best.link, resolution: best.resolutionStr || "?", sourceName: src.sourceName, isDirectMp4: !best.link.includes(".m3u8"), referer: "https://allmanga.to" };
    } catch { continue; }
  }
  return null;
}
async function followRedirects(urlStr, maxHops = 10) {
  let hops = 0, currentUrl = urlStr;
  while (hops < maxHops) {
    const res = await fetch(currentUrl, { method: "HEAD", redirect: "manual", headers: { "User-Agent": USER_AGENT, Referer: "https://allmanga.to" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      const location = res.headers.get("location");
      currentUrl = location.startsWith("http") ? location : new URL(location, currentUrl).href;
      hops++;
    } else return currentUrl;
  }
  return currentUrl;
}

class AllAnimeProvider extends BaseProvider {
  constructor() { super("AllAnime"); this.base = "https://allanime.day"; this.episodeCountMap = new Map(); }
  async _fetchEpisodeSourceUrls(showId, episodeNumber, audio) {
    const translationType = audio === "dub" ? "dub" : "sub";
    const epStr = episodeNumber.toString();
    const candidates = [epStr, epStr.includes(".") ? epStr : epStr + ".0"];
    for (const attempt of candidates) {
      const epRes = await robustFetch(`https://api.allanime.day/api?variables=${encodeURIComponent(JSON.stringify({ showId, translationType, episodeString: attempt }))}&extensions=${encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: "d405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec" } }))}`);
      const body = await epRes.text();
      const sourceUrls = await parseEpisodeSourceUrls(body);
      if (sourceUrls?.length) return sourceUrls;
    }
    return null;
  }
  async search(query, dub) {
    const translationType = dub ? "dub" : "sub";
    const vars = { search: { allowAdult: true, allowUnknown: false, query: query.toLowerCase() }, limit: 40, page: 1, translationType, countryOrigin: "ALL" };
    const res = await robustFetch("https://api.allanime.day/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ variables: vars, query: `query($search:SearchInput $limit:Int $page:Int $translationType:VaildTranslationTypeEnumType $countryOrigin:VaildCountryOriginEnumType){shows(search:$search limit:$limit page:$page translationType:$translationType countryOrigin:$countryOrigin){edges{_id name availableEpisodes}}}` }) });
    if (!res.ok) return [];
    const edges = (await res.json())?.data?.shows?.edges || [];
    edges.forEach(e => { if (e.availableEpisodes) this.episodeCountMap.set(e._id, parseInt(e.availableEpisodes)); });
    return edges.map(e => ({ title: e.name, url: e._id, hasSub: translationType === "sub", hasDub: translationType === "dub" }));
  }
  async findEpisodes(seriesUrl) {
    const totalEp = this.episodeCountMap.get(seriesUrl) || 0;
    if (!totalEp) return [];
    const episodes = [];
    for (let i = 1; i <= totalEp; i++) episodes.push({ dataIds: JSON.stringify({ showId: seriesUrl, episodeNumber: i }), number: i, title: `Episode ${i}` });
    return episodes;
  }
  async findAvailableServers(dataIds, audio) {
    const { showId, episodeNumber } = JSON.parse(dataIds);
    const sourceUrls = await this._fetchEpisodeSourceUrls(showId, episodeNumber, audio);
    if (sourceUrls?.length) {
      return sourceUrls.filter(s => s.sourceUrl?.startsWith("--")).map(s => ({ id: JSON.stringify({ showId, episodeNumber, audio, source: s }), name: `${s.sourceName || "Unknown"} (${audio.toUpperCase()})` }));
    }
    return [{ id: JSON.stringify({ showId, episodeNumber, audio, auto: true }), name: `Auto (Best) (${audio.toUpperCase()})` }];
  }
  async extractStreamFromLinkId(linkId) {
    const { showId, episodeNumber, audio, source, auto } = JSON.parse(linkId);
    let sourceUrls = null;
    if (auto) {
      sourceUrls = await this._fetchEpisodeSourceUrls(showId, episodeNumber, audio);
      if (!sourceUrls) throw new Error("No sources found");
    } else if (source) {
      sourceUrls = [source];
    } else throw new Error("Invalid linkId");
    const r = await trySourceUrls(sourceUrls);
    if (!r || !r.ok) throw new Error("No playable link");
    return { headers: { Referer: r.referer, Origin: new URL(r.referer).origin }, file: r.url, tracks: [] };
  }
}

class AniNekoProvider extends BaseProvider {
  constructor() {
    super("AniNeko");
    this.base = "https://anineko.to";
    this.serverNameMap = {
      "sub-1": { name: "HD-1 (SUB) - Hard Sub", type: "hard", audio: "sub" },
      "sub-2": { name: "HD-2 (SUB) - Hard Sub", type: "hard", audio: "sub" },
      "sub-3": { name: "StreamHG (SUB) - Subtitle version", type: "soft", audio: "sub" },
      "sub-4": { name: "Earnvids (SUB) - Subtitle version", type: "soft", audio: "sub" },
      "sub-5": { name: "Doodstream (SUB) - Subtitle version", type: "soft", audio: "sub" },
      "dub-1": { name: "HD-1 (DUB) - Hard Sub", type: "hard", audio: "dub" },
      "dub-2": { name: "HD-2 (DUB) - Hard Sub", type: "hard", audio: "dub" },
      "dub-3": { name: "StreamHG (DUB) - Subtitle version", type: "soft", audio: "dub" },
      "dub-4": { name: "Earnvids (DUB) - Subtitle version", type: "soft", audio: "dub" },
      "dub-5": { name: "Doodstream (DUB) - Subtitle version", type: "soft", audio: "dub" },
    };
  }
  _attr(tag, name) {
    const m = tag.match(new RegExp(`${name}=["']([^"']*)["']`, "i"));
    return m ? m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"') : "";
  }
  _stripTags(html) { return (html || "").replace(/<[^>]*>/g, "").trim(); }
  _decodeEntities(str) {
    return (str || "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  async _fetchHtml(url, headers = {}) {
    const res = await robustFetch(url, { headers: { "User-Agent": USER_AGENT, ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }
  async _searchSlugs(query) {
    const html = await this._fetchHtml(`${this.base}/browser?keyword=${encodeURIComponent(query)}`).catch(() => "");
    const results = [];
    const regex = /<a\b[^>]*class=["'][^"']*nv-anime-thumb[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;
    for (const m of html.matchAll(regex)) {
      const tag = m[0].match(/<a\b[^>]*>/i)?.[0] ?? "";
      const href = this._attr(tag, "href");
      const slug = href.match(/\/watch\/([^/?#]+)/)?.[1];
      if (!slug) continue;
      const titleMatch = m[0].match(/<(?:h3|[^>]+class=["'][^"']*nv-anime-title[^"']*["'][^>]*)>([\s\S]*?)<\/(?:h3|[^>]+)>/i);
      results.push({ slug, text: titleMatch ? this._stripTags(titleMatch[1]) : slug.replace(/-/g, " ") });
    }
    return results;
  }
  async search(query, dub) {
    const slugResults = await this._searchSlugs(query);
    return slugResults.map(({ slug, text }) => ({ title: text, url: slug, hasSub: true, hasDub: true }));
  }
  async _scrapeSeries(slug) {
    const html = await this._fetchHtml(`${this.base}/watch/${slug}`);
    const episodes = [];
    const regex = /<article\b[^>]*class=["'][^"']*nv-info-episode-item[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi;
    for (const m of html.matchAll(regex)) {
      const block = m[1];
      const link = block.match(/<a\b[^>]*class=["'][^"']*nv-info-episode-main[^"']*["'][^>]*>/i)?.[0] ?? "";
      const href = this._attr(link, "href");
      const num = Number(href.match(/\/ep-(\d+)/)?.[1]);
      if (!Number.isFinite(num)) continue;
      const title = this._stripTags(block.match(/<a\b[^>]*class=["'][^"']*nv-info-episode-main[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "");
      const badges = [...block.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map(b => this._stripTags(b[1]).toLowerCase());
      episodes.push({ number: num, title: title || `Episode ${num}`, epSlug: `ep-${num}`, hasSub: badges.includes("sub"), hasDub: badges.includes("dub") });
    }
    episodes.sort((a, b) => a.number - b.number);
    const seen = new Set();
    return episodes.filter(e => (seen.has(e.number) ? false : (seen.add(e.number), true)));
  }
  async findEpisodes(seriesUrl) {
    const episodes = await this._scrapeSeries(seriesUrl);
    return episodes.map(ep => ({ dataIds: JSON.stringify({ slug: seriesUrl, epSlug: ep.epSlug }), number: ep.number, title: ep.title, hasSub: ep.hasSub, hasDub: ep.hasDub }));
  }
  async _extractVideoAndTracks(embedUrl) {
    const html = await this._fetchHtml(embedUrl, { Referer: `${this.base}/` }).catch(() => "");
    let videoUrl = null;
    const tracks = [];
    const patterns = [
      /const\s+src\s*=\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
      /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
      /["'](https?:\/\/[^"']+\/master\.m3u8[^"']*)["']/i,
      /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    ];
    for (const pattern of patterns) {
      const m = html.match(pattern);
      if (m) { videoUrl = this._decodeEntities(m[1]); break; }
    }
    const trackRegex = /<track[^>]+src=["']([^"']+\.(?:vtt|ass))["'][^>]*/gi;
    let trackMatch;
    while ((trackMatch = trackRegex.exec(html)) !== null) {
      const src = trackMatch[1];
      let label = "Unknown";
      const labelMatch = html.match(/label=["']([^"']+)["']/i);
      if (labelMatch) label = labelMatch[1];
      const isDefault = html.includes("default") || html.includes("selected");
      tracks.push({ file: src.startsWith("http") ? src : new URL(src, embedUrl).href, label, kind: "subtitles", default: isDefault });
    }
    return { videoUrl, tracks };
  }
  async _scrapeEpisodeWatch(seriesSlug, epSlug, audio) {
    const html = await this._fetchHtml(`${this.base}/watch/${seriesSlug}/${epSlug}`, { Referer: `${this.base}/watch/${seriesSlug}` });
    const servers = [];
    const panelRegex = /<div\b[^>]*class=["'][^"']*nv-server-grid[^"']*["'][^>]*data-id=["']([^"']+)["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*nv-server-grid|$)/gi;
    let panelMatch;
    while ((panelMatch = panelRegex.exec(html)) !== null) {
      const serverId = panelMatch[1];
      const panelContent = panelMatch[2];
      const panelAudio = serverId.startsWith("dub") ? "dub" : "sub";
      if (panelAudio !== audio) continue;
      const btnRegex = /data-video=["']([^"']+)["']/gi;
      let btnMatch;
      while ((btnMatch = btnRegex.exec(panelContent)) !== null) {
        const embedUrl = this._decodeEntities(btnMatch[1]);
        const serverInfo = this.serverNameMap[serverId] || { name: `${serverId.toUpperCase()} (${audio.toUpperCase()})`, type: "hard", audio };
        servers.push({ id: serverId, name: serverInfo.name, type: serverInfo.type, embedUrl });
      }
    }
    return servers;
  }
  async findAvailableServers(dataIds, audio) {
    const { slug, epSlug } = JSON.parse(dataIds);
    const servers = await this._scrapeEpisodeWatch(slug, epSlug, audio);
    return servers.map(server => ({ id: JSON.stringify({ embedUrl: server.embedUrl, type: server.type, audio, slug }), name: server.name }));
  }
  async extractStreamFromLinkId(linkId) {
    const { embedUrl, type } = JSON.parse(linkId);
    const { videoUrl, tracks } = await this._extractVideoAndTracks(embedUrl);
    if (!videoUrl) throw new Error("No video stream found");
    return { headers: { Referer: this.base, Origin: this.base }, file: videoUrl, tracks: type === "soft" ? tracks : [] };
  }
}

async function pbkdf2(password, salt, iterations, keylen) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const derivedBits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations, hash: 'SHA-256' }, keyMaterial, keylen * 8);
  return new Uint8Array(derivedBits);
}

class ReAnimeProvider extends BaseProvider {
  constructor() { super("ReAnime"); this.base = "https://reanime.to"; this.flix = "https://flixcloud.cc"; this.userAgent = USER_AGENT; }
  async sha256hex(s) { return memoizedSha256(s); }
  b64toU8(b64) { return Uint8Array.from(atob(b64), c=>c.charCodeAt(0)); }
  async deriveFields(seed) {
    let e = seed;
    for (let i=0;i<3;i++) e = await this.sha256hex(e + i);
    let l = e;
    for (let i=0;i<3;i++) l = await this.sha256hex(l + i);
    return { keyField: "kf_"+e.substring(8,16), ivField: "ivf_"+e.substring(16,24), containerName: "cd_"+e.substring(24,32), arrayName: "ad_"+e.substring(32,40), objectName: "od_"+e.substring(40,48), tokenField: e.substring(48,64)+"_"+e.substring(56,64), keyFrag2Field: l.substring(0,16)+"_"+l.substring(16,24) };
  }
  extractSsrObj(html) {
    const m = html.match(/\{type:"data",data:(\{)/);
    if (!m) throw new Error("SSR data block not found");
    let depth = 0;
    const start = html.indexOf("{", m.index + m[0].length - 1);
    for (let i = start; i < html.length; i++) {
      if (html[i] === "{") depth++;
      else if (html[i] === "}") { if (--depth === 0) return html.slice(start, i+1); }
    }
    throw new Error("SSR brace matching failed");
  }
  parseJsLiteral(src) {
    let i=0;
    const ws=()=>{while(i<src.length && /\s/.test(src[i])) i++;};
    const parseValue=()=>{
      ws();
      if(src[i]==="{") return parseObject();
      if(src[i]==="[") return parseArray();
      if(src[i]==='"') return parseDStr();
      if(src[i]==="'") return parseSStr();
      if(src.startsWith("true",i)){i+=4; return true;}
      if(src.startsWith("false",i)){i+=5; return false;}
      if(src.startsWith("null",i)){i+=4; return null;}
      if(src.startsWith("undefined",i)){i+=9; return null;}
      if(src.startsWith("!0",i)){i+=2; return true;}
      if(src.startsWith("!1",i)){i+=2; return false;}
      const m=src.slice(i).match(/^-?[\d.]+([eE][+-]?\d+)?/);
      if(m){i+=m[0].length; return parseFloat(m[0]);}
      throw new Error(`JS parse error at pos ${i}`);
    };
    const parseDStr=()=>{
      let r=""; i++;
      while(i<src.length && src[i]!=='"'){
        if(src[i]==='\\'){i++; const e={n:"\n",t:"\t",r:"\r",'"':'"',"\\":"\\"}; r+=e[src[i]]??src[i]; i++;}
        else r+=src[i++];
      }
      i++; return r;
    };
    const parseSStr=()=>{
      let r=""; i++;
      while(i<src.length && src[i]!="'"){
        if(src[i]==='\\'){i++; r+=src[i]==="'"?"'":{n:"\n",t:"\t",r:"\r",'"':'"',"\\":"\\"}[src[i]]??src[i]; i++;}
        else r+=src[i++];
      }
      i++; return r;
    };
    const parseKey=()=>{
      ws();
      if(src[i]==='"') return parseDStr();
      if(src[i]==="'") return parseSStr();
      const m=src.slice(i).match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/);
      if(m){i+=m[0].length; return m[0];}
      throw new Error(`Bad key at pos ${i}`);
    };
    const parseObject=()=>{
      const obj={}; i++; ws();
      while(i<src.length && src[i]!=="}"){
        if(src[i]===","){i++; ws(); continue;}
        const k=parseKey(); ws(); i++;
        obj[k]=parseValue(); ws();
      }
      i++; return obj;
    };
    const parseArray=()=>{
      const arr=[]; i++; ws();
      while(i<src.length && src[i]!=="]"){
        if(src[i]===","){i++; ws(); continue;}
        arr.push(parseValue()); ws();
      }
      i++; return arr;
    };
    return parseValue();
  }
  parseWasmDecrypt(wasmBytes) {
    const b = wasmBytes;
    let pos = 8;
    while (pos < b.length) {
      const secId = b[pos++];
      let sz=0, sh=0, by;
      do { by = b[pos++]; sz |= (by & 127) << sh; sh += 7; } while (by & 128);
      if (secId === 10) { pos++; let sbs=0, sh2=0, by2; do { by2 = b[pos++]; sbs |= (by2 & 127) << sh2; sh2 += 7; } while (by2 & 128); pos += sbs; break; }
      pos += sz;
    }
    let rbs=0, sh3=0, by3;
    do { by3 = b[pos++]; rbs |= (by3 & 127) << sh3; sh3 += 7; } while (by3 & 128);
    const r = b.slice(pos, pos + rbs);
    const leb = (arr, idx) => { let v=0, s=0, b2; do { b2 = arr[idx++]; v |= (b2 & 127) << s; s += 7; } while (b2 & 128); return [v, idx]; };
    const XOR_END = [32,2,32,5,106,45,0,0,115,33,6];
    let txStart = -1;
    outer: for (let i=0; i<r.length-XOR_END.length; i++) {
      for (let j=0; j<XOR_END.length; j++) if (r[i+j] !== XOR_END[j]) continue outer;
      txStart = i + XOR_END.length; break;
    }
    if (txStart < 0) throw new Error("WASM: transform start not found");
    let txEnd = -1, step = 36;
    for (let i=txStart; i<r.length-4; i++) {
      if (r[i] === 32 && r[i+1] === 5 && r[i+2] === 65) {
        const [val, ni] = leb(r, i+3);
        if (r[ni] === 108) { txEnd = i; step = val; break; }
      }
    }
    if (txEnd < 0) throw new Error("WASM: keystream not found");
    const code = r.slice(txStart, txEnd);
    const transform = (inputByte) => {
      let local6 = inputByte & 255;
      const stk = [];
      let ip = 0;
      while (ip < code.length) {
        const op = code[ip++];
        if (op === 32) {
          const [idx, ni] = leb(code, ip);
          ip = ni;
          stk.push(idx === 6 ? local6 : 0);
        } else if (op === 33) {
          const [idx, ni] = leb(code, ip);
          ip = ni;
          const v = stk.pop();
          if (idx === 6) local6 = v & 255;
        } else if (op === 65) {
          const [v, ni] = leb(code, ip);
          ip = ni;
          stk.push(v);
        } else if (op === 106) {
          const b2 = stk.pop(), a = stk.pop();
          stk.push((a + b2) & 255);
        } else if (op === 107) {
          const b2 = stk.pop(), a = stk.pop();
          stk.push((a - b2 + 256) & 255);
        } else if (op === 113) {
          const b2 = stk.pop(), a = stk.pop();
          stk.push((a & b2) & 255);
        } else if (op === 114) {
          const b2 = stk.pop(), a = stk.pop();
          stk.push((a | b2) & 255);
        } else if (op === 115) {
          const b2 = stk.pop(), a = stk.pop();
          stk.push((a ^ b2) & 255);
        } else if (op === 116) {
          const b2 = stk.pop(), a = stk.pop();
          stk.push((a << (b2 & 7)) & 255);
        } else if (op === 118) {
          const b2 = stk.pop(), a = stk.pop();
          stk.push((a >>> (b2 & 7)) & 255);
        }
      }
      return local6;
    };
    return { step, transform };
  }
  runDecrypt(wasmBytes, frag1, kf2, T, seedInt) {
    const { step, transform } = this.parseWasmDecrypt(wasmBytes);
    const out = new Uint8Array(frag1.length);
    for (let i=0; i<frag1.length; i++) {
      const c = (frag1[i] ^ kf2[i] ^ T[i]) & 255;
      out[i] = transform(c) ^ ((i * step + seedInt) & 255);
    }
    return out;
  }
  async decryptEmbed(html) {
    const raw = this.extractSsrObj(html);
    const data = this.parseJsLiteral(raw);
    const seed = data.obfuscation_seed;
    if (!seed) throw new Error("obfuscation_seed missing");
    const fields = await this.deriveFields(seed);
    const ocd = data.obfuscated_crypto_data;
    if (!ocd) throw new Error("obfuscated_crypto_data missing");
    const container = ocd[fields.containerName];
    if (!container) throw new Error(`containerName "${fields.containerName}" not in ocd`);
    const arr = container[fields.arrayName];
    if (!arr) throw new Error(`arrayName "${fields.arrayName}" not in container`);
    const obj = arr[0][fields.objectName];
    if (!obj) throw new Error(`objectName "${fields.objectName}" not in arr[0]`);
    const frag1 = this.b64toU8(obj[fields.keyField]);
    const iv = this.b64toU8(obj[fields.ivField]);
    const kf2raw = data[fields.keyFrag2Field];
    if (!kf2raw) throw new Error(`kf2 field "${fields.keyFrag2Field}" not in data`);
    const kf2 = this.b64toU8(kf2raw);
    const token = data[fields.tokenField];
    if (!token) throw new Error(`tokenField "${fields.tokenField}" missing`);
    const tokRes = await robustFetch(`${this.flix}/api/m3u8/${token}`, { headers: { "User-Agent": this.userAgent, Referer: `${this.base}/` } });
    if (!tokRes.ok) throw new Error(`Token API ${tokRes.status}`);
    const tokData = await tokRes.json();
    const vidKey = (await this.sha256hex(token + "vid")).substring(0,10);
    const keyKey = (await this.sha256hex(token + "key")).substring(0,10);
    const v_bytes = this.b64toU8(tokData[vidKey]);
    const T_bytes = this.b64toU8(tokData[keyKey]);
    if (!v_bytes.length || !T_bytes.length) throw new Error("Token fields missing");
    const seedInt = parseInt(seed.substring(0,8), 16);
    const wPayload = this.b64toU8(data.w_payload ?? "");
    if (!wPayload.length) throw new Error("w_payload missing");
    const wasmOut = this.runDecrypt(wPayload, frag1, kf2, T_bytes, seedInt);
    const derivedKey = await pbkdf2(String.fromCharCode(...wasmOut), seed, 1000, 32);
    for (let i=0;i<32;i++) derivedKey[i] ^= seed.charCodeAt(i % seed.length);
    const aesKey = await crypto.subtle.digest('SHA-256', derivedKey);
    const aesKeyBuffer = await crypto.subtle.importKey('raw', aesKey, { name: 'AES-CBC' }, false, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aesKeyBuffer, v_bytes);
    let plain = new TextDecoder().decode(decrypted);
    plain = plain.trim().replace(/\0+$/, "");
    if (!plain.startsWith("http")) throw new Error(`Unexpected decrypted value: ${plain.substring(0,60)}`);
    return { url: plain, subtitles: data.subtitles ?? [], thumbnails_vtt: data.thumbnails_vtt ?? null, video_title: data.video_title ?? null, intro_chapter: data.intro_chapter ?? null, outro_chapter: data.outro_chapter ?? null, video_id: data.video_id ?? null };
  }
  async resolveIds(anilistId) {
    const cacheKey = `reanime:ids:${anilistId}`;
    const cached = await kvGet(cacheKey);
    if (cached) return cached;
    const media = await anilistQuery(`query ($id: Int) { Media(id: $id, type: ANIME) { idMal title { romaji english } } }`, { id: parseInt(anilistId) });
    const mediaData = media?.Media;
    if (!mediaData) throw new Error(`AniList ID ${anilistId} not found`);
    const title = mediaData.title.english || mediaData.title.romaji;
    const malId = mediaData.idMal;
    let anizip = null;
    try { const zipRes = await robustFetch(`https://api.ani.zip/mappings?anilist_id=${anilistId}`); anizip = await zipRes.json(); } catch {}
    const result = { title, malId, anizip };
    await kvPut(cacheKey, result, 21600);
    return result;
  }
  async findSlug(title) {
    const cacheKey = `reanime:slug:${await memoizedSha256(title)}`;
    const cached = await kvGet(cacheKey);
    if (cached) return cached;
    const res = await robustFetch(`${this.base}/api/search?${new URLSearchParams({ q: title, limit: 5 })}`, { headers: { "User-Agent": this.userAgent } });
    const data = await res.json();
    const results = Array.isArray(data) ? data : (data.results ?? data.data ?? []);
    if (!results.length) throw new Error(`No reanime results for "${title}"`);
    const id = results[0].anime_id ?? results[0].slug ?? results[0].id;
    if (!id) throw new Error("Could not extract anime_id");
    await kvPut(cacheKey, id, 86400);
    return id;
  }
  async jikanFetch(url, retries=4) {
    for (let attempt=0; attempt<=retries; attempt++) {
      const res = await robustFetch(url, { headers: { "User-Agent": this.userAgent, Accept: "application/json" } });
      if (res.status === 429) {
        const wait = (parseInt(res.headers.get("retry-after")||"1")*1000) + (attempt*500);
        if (attempt < retries) { await new Promise(r=>setTimeout(r,wait)); continue; }
        return null;
      }
      if (res.ok) return res.json();
      return null;
    }
    return null;
  }
  async getJikanEpisodes(malId, page) { const data = await this.jikanFetch(`https://api.jikan.moe/v4/anime/${malId}/episodes?page=${page}`); return data || { data: [], pagination: { last_visible_page: 1, has_next_page: false } }; }
  async search(query, dub) {
    const gql = `query ($search: String, $page: Int, $perPage: Int) { Page(page: $page, perPage: $perPage) { media(search: $search, type: ANIME, sort: SEARCH_MATCH) { id title { romaji english } } } }`;
    const data = await anilistQuery(gql, { search: query, page: 1, perPage: 20 });
    const mediaList = data?.Page?.media || [];
    return mediaList.map(m => ({ title: m.title.english || m.title.romaji, url: String(m.id), hasSub: true, hasDub: true }));
  }
  async findEpisodes(seriesUrl) {
    const anilistId = parseInt(seriesUrl,10);
    if (isNaN(anilistId)) return [];
    const { title, malId, anizip } = await this.resolveIds(anilistId);
    let episodes = [];
    if (!malId && anizip?.episodes) {
      const eps = Object.entries(anizip.episodes).map(([num]) => parseInt(num));
      eps.sort((a,b)=>a-b);
      for (const num of eps) episodes.push({ dataIds: JSON.stringify({ anilistId, episodeNumber: num }), number: num, title: `Episode ${num}` });
    } else if (malId) {
      const first = await this.getJikanEpisodes(malId, 1);
      const lastPage = first.pagination?.last_visible_page || 1;
      let allEps = [...first.data];
      if (lastPage > 1) {
        const pages = await Promise.all(Array.from({ length: lastPage - 1 }, (_, i) => this.getJikanEpisodes(malId, i + 2)));
        allEps = allEps.concat(pages.flatMap(p => p.data));
      }
      for (const ep of allEps) episodes.push({ dataIds: JSON.stringify({ anilistId, episodeNumber: ep.mal_id }), number: ep.mal_id, title: ep.title || `Episode ${ep.mal_id}` });
    }
    return episodes.sort((a,b)=>a.number-b.number);
  }
  async findAvailableServers(dataIds, audio) {
    const { anilistId, episodeNumber } = JSON.parse(dataIds);
    const { title } = await this.resolveIds(anilistId);
    const slug = await this.findSlug(title);
    const [watchRes, flixRes] = await Promise.allSettled([
      robustFetch(`${this.base}/api/watch/${slug}/${episodeNumber}`, { headers: { "User-Agent": this.userAgent } }),
      robustFetch(`${this.base}/api/flix/${anilistId}/${episodeNumber}`, { headers: { "User-Agent": this.userAgent } })
    ]);
    const watchData = watchRes.status === "fulfilled" ? await watchRes.value.json() : null;
    const flixData = flixRes.status === "fulfilled" ? await flixRes.value.json() : null;
    const links = [...(watchData?.episode_links || [])];
    if (flixData?.success && flixData?.servers) {
      const seen = new Set(links.map(s=>s.$id));
      for (const s of flixData.servers) if (!seen.has(s.$id)) links.push(s);
    }
    const audioTypes = audio === "sub" ? ["sub","s-sub"] : ["dub","s-dub"];
    return links.filter(s=>audioTypes.includes(s.dataType)).map(s=>({ id: JSON.stringify({ anilistId, episodeNumber, audio, dataLink: s.dataLink, serverName: s.serverName }), name: `${s.serverName} (${audio.toUpperCase()})` }));
  }
  async extractStreamFromLinkId(linkId) {
    const { dataLink } = JSON.parse(linkId);
    const embedRes = await robustFetch(dataLink, { headers: { "User-Agent": this.userAgent, Referer: `${this.base}/` } });
    const embedHtml = await embedRes.text();
    const stream = await this.decryptEmbed(embedHtml);
    return { headers: { Referer: this.base, Origin: this.base }, file: stream.url, tracks: stream.subtitles || [] };
  }
}

class AnimeverseProvider extends BaseProvider {
  constructor() {
    super("Animeverse");
    this.baseUrl = "https://animeverse.to";
  }

  async search(query, dub) {
    const searchUrl = `${this.baseUrl}/search?q=${encodeURIComponent(query)}`;
    const html = await this._fetchHtml(searchUrl, "a[href*='/watch/']");
    if (!html) return [];

    const $ = cheerio.load(html);
    let watchLink = null;
    let title = query;
    $('a[href*="/watch/"]').each((_, el) => {
      if (watchLink) return false;
      const href = $(el).attr('href');
      if (!href) return;
      watchLink = href.startsWith('http') ? href : `${this.baseUrl}${href}`;
      const text = $(el).text().trim() || $(el).find('img').attr('alt') || '';
      if (text) title = text;
    });

    if (!watchLink) return [];
    return [{ title, url: watchLink, hasSub: true, hasDub: false }];
  }

  async findEpisodes(seriesUrl) {
    const html = await this._fetchHtml(seriesUrl);
    if (!html) return [];

    const $ = cheerio.load(html);
    const episodes = [];

    $('a[href*="/watch/"]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const match = href.match(/(?:ep(?:isode)?[-_]?)(\d+)/i);
      if (match) {
        const epNum = parseInt(match[1], 10);
        const fullUrl = href.startsWith('http') ? href : `${this.baseUrl}${href}`;
        episodes.push({
          dataIds: JSON.stringify({ episodeUrl: fullUrl, number: epNum }),
          number: epNum,
          title: $(el).text().trim() || `Episode ${epNum}`
        });
      }
    });

    if (episodes.length === 0) {
      const iframe = $('iframe').first();
      if (iframe.length && iframe.attr('src')) {
        episodes.push({
          dataIds: JSON.stringify({ embedUrl: iframe.attr('src'), number: 1 }),
          number: 1,
          title: 'Episode 1'
        });
      }
    }

    return episodes.sort((a, b) => a.number - b.number);
  }

  async findAvailableServers(dataIds, audio) {
    const { episodeUrl, embedUrl } = JSON.parse(dataIds);
    if (audio !== "sub") return [];

    if (embedUrl) {
      return [{
        id: JSON.stringify({ embedUrl, referer: episodeUrl || this.baseUrl }),
        name: `Animeverse (${audio.toUpperCase()})`
      }];
    }

    const html = await this._fetchHtml(episodeUrl);
    if (!html) return [];

    const $ = cheerio.load(html);
    const iframe = $('iframe').first();
    if (!iframe.length || !iframe.attr('src')) return [];

    const src = iframe.attr('src');
    return [{
      id: JSON.stringify({ embedUrl: src, referer: episodeUrl }),
      name: `Animeverse (${audio.toUpperCase()})`
    }];
  }

  async extractStreamFromLinkId(linkId) {
    const { embedUrl, referer } = JSON.parse(linkId);
    if (!embedUrl) throw new Error("No embed URL found");
    const finalUrl = embedUrl.startsWith('http') ? embedUrl : `${this.baseUrl}${embedUrl}`;
    return {
      headers: { Referer: referer || this.baseUrl, Origin: this.baseUrl },
      file: finalUrl,
      tracks: []
    };
  }

  async _fetchHtml(url, waitForSelector = null) {
    try {
      const res = await robustFetch(url, { headers: { Referer: this.baseUrl, "User-Agent": USER_AGENT } });
      if (!res.ok) return null;
      const html = await res.text();
      if (waitForSelector) {
        const $ = cheerio.load(html);
        if ($(waitForSelector).length === 0) return null;
      }
      return html;
    } catch (err) {
      console.error(`[Animeverse] Fetch error for ${url}:`, err.message);
      return null;
    }
  }
}

class AniZoneProvider extends BaseProvider {
  constructor() { super("AniZone"); this.base = "https://anizone.to"; this.headers = { "User-Agent": USER_AGENT, "Referer": this.base + "/", "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }; }
  _extractCardInfo($, el) {
    const href = $(el).find('a[href*="/anime/"]').first().attr('href');
    if (!href) return null;
    const parts = href.split('/');
    const slug = parts[parts.length - 1] || parts[parts.length - 2];
    const xData = $(el).attr('x-data') || '';
    const defaultTitleMatch = xData.match(/window\.getTitle\(this\.anmTitles,\s*'([^']+)'\)/);
    const defaultTitle = defaultTitleMatch ? defaultTitleMatch[1] : '';
    const titles = new Set();
    if (defaultTitle) titles.add(defaultTitle);
    const jsonMatch = xData.match(/JSON\.parse\('([^']+)'\)/);
    if (jsonMatch) {
      try {
        let jsonStr = jsonMatch[1].replace(/\\\\/g, '\\').replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\'/g, "'");
        const parsed = JSON.parse(jsonStr);
        Object.values(parsed).forEach(t => { if (t) titles.add(t); });
      } catch (e) {}
    }
    return { slug, titles: Array.from(titles) };
  }
  _normalize(str) { return str.toLowerCase().replace(/[^a-z0-9]/g, '').trim(); }
  _getSeasonRegexes(season) {
    if (season === 1) return { mustNot: [/season\s*[2-9]/i, /[\s\-][iI]{2,}/, /\s+[2-9]nd/i, /\s+[2-9]rd/i, /\s+[2-9]th/i, /\s+ii/i, /\s+iii/i, /\s+iv/i, /\s+v/i] };
    const patterns = [];
    if (season === 2) patterns.push(/season\s*2/i, /2nd\s*season/i, /[\s\-]ii\b/i, /\b2\b/);
    else if (season === 3) patterns.push(/season\s*3/i, /3rd\s*season/i, /[\s\-]iii\b/i, /\b3\b/);
    else if (season === 4) patterns.push(/season\s*4/i, /4th\s*season/i, /[\s\-]iv\b/i, /\b4\b/);
    else patterns.push(new RegExp(`season\\s*${season}`, 'i'), new RegExp(`\\b${season}\\b`));
    return { must: patterns };
  }
  _matchCard(cards, jikanTitle, baseTitle, season) {
    const normalizedJikan = this._normalize(jikanTitle);
    const normalizedJikanNoSub = this._normalize(jikanTitle.split(':')[0]);
    const normalizedBase = this._normalize(baseTitle);
    for (const card of cards) {
      for (const title of card.titles) {
        const normTitle = this._normalize(title);
        const normTitleNoSub = this._normalize(title.split(':')[0]);
        if (normTitle === normalizedJikan || normTitleNoSub === normalizedJikanNoSub) return card.slug;
      }
    }
    const seasonRules = this._getSeasonRegexes(season);
    for (const card of cards) {
      let matchesBase = false;
      for (const title of card.titles) if (this._normalize(title).includes(normalizedBase)) { matchesBase = true; break; }
      if (!matchesBase) continue;
      let seasonMatches = false;
      if (season === 1) {
        let hasOtherSeason = false;
        for (const title of card.titles) if (seasonRules.mustNot.some(regex => regex.test(title))) { hasOtherSeason = true; break; }
        if (!hasOtherSeason) seasonMatches = true;
      } else {
        for (const title of card.titles) if (seasonRules.must.some(regex => regex.test(title))) { seasonMatches = true; break; }
      }
      if (seasonMatches) return card.slug;
    }
    return null;
  }
  _matchMovieCard(cards, targetTitle) {
    const normTarget = this._normalize(targetTitle);
    for (const card of cards) for (const title of card.titles) if (this._normalize(title) === normTarget) return card.slug;
    for (const card of cards) for (const title of card.titles) if (this._normalize(title).includes(normTarget) || normTarget.includes(this._normalize(title))) return card.slug;
    return cards[0]?.slug || null;
  }
  async search(query, dub) {
    const res = await robustFetch(`${this.base}/anime?search=${encodeURIComponent(query)}`, { headers: this.headers });
    if (!res.ok) return [];
    const $ = cheerio.load(await res.text());
    const cards = [];
    $('[x-data*="anmTitles"]').each((i, el) => { const info = this._extractCardInfo($, el); if (info) cards.push(info); });
    if (cards.length) return cards.map(card => ({ title: card.titles[0] || card.slug.replace(/-/g, ' '), url: card.slug, hasSub: true, hasDub: true }));
    const results = [];
    $('main a').each((i, el) => {
      const href = $(el).attr('href');
      if (href && (href.startsWith('https://anizone.to/anime/') || href.startsWith('/anime/'))) {
        const slug = href.split('/').pop();
        const title = $(el).find('h2, p, .title').first().text().trim() || slug;
        results.push({ title, url: slug, hasSub: true, hasDub: true });
      }
    });
    return results;
  }
  async findEpisodes(seriesUrl) {
    const slug = seriesUrl;
    const res = await robustFetch(`${this.base}/anime/${slug}/1`, { headers: this.headers });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const episodes = [];
    const epRegex = /<a[^>]*href="([^"]*\/anime\/[^"]+?)"[^>]*>\s*<div[^>]*>\s*<div[^>]*class='[^']*min-w-10[^']*'[^>]*>(\d+)<\/div>\s*<div[^>]*class="[^"]*line-clamp-1[^"]*"[^>]*>([^<]+)<\/div>/g;
    let match;
    while ((match = epRegex.exec(html)) !== null) {
      const [, href, num, title] = match;
      const episodeId = href.split('/').pop() ?? num;
      episodes.push({ dataIds: JSON.stringify({ slug, episodeId, url: href }), number: parseInt(num, 10), title: title.trim() });
    }
    if (!episodes.length) {
      $('a[href^="/anime/"]').each((i, el) => {
        const href = $(el).attr('href');
        const parts = href.split('/');
        const epNum = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(epNum) && epNum > 0) {
          const epTitle = $(el).find('div[class*="line-clamp"]').text().trim() || `Episode ${epNum}`;
          episodes.push({ dataIds: JSON.stringify({ slug, episodeId: String(epNum), url: href }), number: epNum, title: epTitle });
        }
      });
    }
    return episodes.sort((a,b) => a.number - b.number);
  }
  async findAvailableServers(dataIds, audio) {
    const { slug, episodeId, url } = JSON.parse(dataIds);
    const epUrl = url || `${this.base}/anime/${slug}/${episodeId}`;
    const res = await robustFetch(epUrl, { headers: this.headers });
    if (!res.ok) throw new Error("Failed to fetch episode page");
    const html = await res.text();
    const $ = cheerio.load(html);
    let masterUrl = $('media-player').attr('src');
    if (!masterUrl) { const matches = html.match(/https:\/\/[^"']+\/master\.m3u8/); if (matches) masterUrl = matches[0]; }
    if (!masterUrl) throw new Error("No m3u8 URL found");
    const subtitles = [];
    $('track').each((i, el) => {
      const src = $(el).attr('src');
      const kind = $(el).attr('kind');
      if (src && (kind === 'subtitles' || kind === 'captions' || src.endsWith('.ass') || src.endsWith('.vtt'))) {
        subtitles.push({ url: src, name: $(el).attr('label') || 'English', language: $(el).attr('srclang') || 'en' });
      }
    });
    let format = "Sub";
    $('button').each((i, el) => {
      const text = $(el).text();
      if (text.includes('Audio:')) {
        const hasJapanese = text.includes('Japanese');
        const hasEnglish = text.includes('English');
        if (hasEnglish && !hasJapanese) format = "Dub";
        else if (hasEnglish && hasJapanese) format = "Sub & Dub";
      }
    });
    if (format === "Sub") {
      $('button[wire\\:click^="setVideo"]').each((i, el) => {
        const btnText = $(el).text();
        const hasJapanese = btnText.includes('Japanese');
        const hasEnglish = btnText.includes('English');
        if (hasEnglish && !hasJapanese) format = "Dub";
        else if (hasEnglish && hasJapanese) format = "Sub & Dub";
      });
    }
    const serverId = JSON.stringify({ masterUrl, subtitles, audio, format, name: "AniZone", title: `${slug} - Episode ${episodeId} [${format}]`, quality: "Multi", headers: this.headers });
    return [{ id: serverId, name: `AniZone (${audio.toUpperCase()})` }];
  }
  async extractStreamFromLinkId(linkId) {
    const { masterUrl, subtitles, headers } = JSON.parse(linkId);
    const tracks = subtitles.map(sub => ({ file: sub.url, label: sub.name, kind: "subtitles", default: false }));
    return { headers: headers || this.headers, file: masterUrl, tracks };
  }
}

function absUrl(url, base) {
  if (url.search(/^\w+:\/\//) === 0) return url;
  if (url.startsWith('/')) return base.slice(0, base.lastIndexOf('/')) + url;
  return base.slice(0, base.lastIndexOf('/') + 1) + url;
}

function fixMojibake(str) {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    out += String.fromCharCode(str.charCodeAt(i) & 0xFF);
  }
  return decodeURIComponent(escape(out));
}

const m3u8RegexCache = {
  media: /^#EXT-X-MEDIA:(.*)$/gm,
  stream: /^#EXT-X-STREAM-INF:(.*)$/gm,
  streamUrl: /\n([^\n#][^\n]*)/,
  type: /TYPE=([\w-]*)/,
  groupId: /GROUP-ID="([^"]*)"/,
  language: /LANGUAGE="([^"]*)"/,
  name: /NAME="([^"]*)"/,
  uri: /URI="([^"]*)"/,
  default: /DEFAULT=YES/,
  resolution: /RESOLUTION=([\dx]+)/,
  bandwidth: /BANDWIDTH=(\d+)/,
  avgBandwidth: /AVERAGE-BANDWIDTH=(\d+)/,
  video: /VIDEO="([^"]*)"/,
  audio: /AUDIO="([^"]*)"/,
  subtitles: /SUBTITLES="([^"]*)"/,
  captions: /CLOSED-CAPTIONS="([^"]*)"/,
};

function extractAttr(text, regex) {
  const match = regex.exec(text);
  return match ? match[1] : null;
}

async function m3u8Extractor(url, text, headers, incSubs = null) {
  const videos = {}, audios = {}, subtitles = {}, captions = {};
  const streams = [];

  let mediaMatch;
  m3u8RegexCache.media.lastIndex = 0;
  while ((mediaMatch = m3u8RegexCache.media.exec(text)) !== null) {
    const info = mediaMatch[1];
    const type = extractAttr(info, m3u8RegexCache.type);
    if (!type) continue;

    const group = extractAttr(info, m3u8RegexCache.groupId);
    if (!group) continue;

    const medium = {
      lang: extractAttr(info, m3u8RegexCache.language),
      name: extractAttr(info, m3u8RegexCache.name),
      uri: extractAttr(info, m3u8RegexCache.uri),
      default: m3u8RegexCache.default.test(info),
      autoselect: /AUTOSELECT=YES/.test(info),
    };

    const typeDict = { 'VIDEO': videos, 'AUDIO': audios, 'SUBTITLES': subtitles, 'CLOSED-CAPTIONS': captions }[type];
    if (typeDict) {
      if (!typeDict[group]) typeDict[group] = [];
      typeDict[group].push(medium);
    }
  }

  let streamMatch;
  m3u8RegexCache.stream.lastIndex = 0;
  while ((streamMatch = m3u8RegexCache.stream.exec(text)) !== null) {
    const info = streamMatch[1];
    const nextNewline = text.indexOf('\n', streamMatch.index + streamMatch[0].length);
    const streamUrl = nextNewline > -1 ? text.substring(streamMatch.index + streamMatch[0].length + 1, nextNewline).trim() : '';

    if (!streamUrl || streamUrl.startsWith('#')) continue;

    const videoGroup = extractAttr(info, m3u8RegexCache.video);
    const audioGroup = extractAttr(info, m3u8RegexCache.audio);
    const subGroup = extractAttr(info, m3u8RegexCache.subtitles);

    let quality = 'Auto';
    const resMatch = extractAttr(info, m3u8RegexCache.resolution);
    if (resMatch) {
      const heightMatch = resMatch.match(/x(\d+)/);
      quality = heightMatch ? heightMatch[1] + 'p' : quality;
    } else {
      const avgBw = extractAttr(info, m3u8RegexCache.avgBandwidth);
      const bw = extractAttr(info, m3u8RegexCache.bandwidth);
      const bandwidth = parseInt(avgBw || bw || 0);
      if (bandwidth > 0) quality = (bandwidth / 1000000).toFixed(1) + 'Mb/s';
    }

    const mediaList = videos[videoGroup] || subtitles[subGroup] || [];
    const audioList = audios[audioGroup] || [];
    const subs = mediaList.length > 0 ? mediaList.map((s) => ({
      file: absUrl(s.uri, url),
      label: s.name || 'Unknown'
    })) : incSubs;
    const auds = audioList.length > 0 ? audioList.map((a) => ({
      file: absUrl(a.uri, url),
      label: a.name || 'Unknown'
    })) : null;

    streams.push({
      url: absUrl(streamUrl, url),
      quality,
      originalUrl: absUrl(streamUrl, url),
      headers,
      subtitles: subs,
      audios: auds
    });
  }

  return streams.length > 0 ? streams : [{
    url,
    quality: 'Auto',
    originalUrl: url,
    headers,
    subtitles: incSubs,
    audios: null
  }];
}
// ================================ WcoStreamProvider ================================
class WcoStreamProvider extends BaseProvider {
  constructor() {
    super("WcoStream");
    this.baseUrl = "https://www.wcostream.tv";
    this.userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0";
  }

  async _fetchHtml(url, options = {}) {
    const res = await robustFetch(url, {
      headers: { "User-Agent": this.userAgent, ...options.headers },
      ...options,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }

  async _makeRequest(url, method = "GET", data = null, headers = {}, useCache = true) {
    const opts = {
      method,
      headers: {
        "User-Agent": this.userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        ...headers,
      },
    };
    if (method === "POST" && data) {
      opts.body = data;
      if (!opts.headers["Content-Type"]) {
        opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
    }
    try {
      const res = await robustFetch(url, opts);
      if (!res.ok) return null;
      return await res.text();
    } catch (err) {
      console.error(`[WcoStream] Request failed: ${url}`, err.message);
      return null;
    }
  }

  _unescapeHtmlUrl(url) {
    return (url || "").replace(/&amp;/g, "&").replace(/&#38;/g, "&");
  }

  _ensureFullUrl(baseUrl, url) {
    url = this._unescapeHtmlUrl(url);
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    if (url.startsWith("//")) return "https:" + url;
    return new URL(url, baseUrl).href;
  }

  _embedApiOrigin(embedUrl) {
    try {
      const parsed = new URL(embedUrl);
      return `${parsed.protocol}//${parsed.hostname}/`;
    } catch {
      return "https://embed.wcostream.com/";
    }
  }

  async _findEmbedUrl(pageContent, episodeUrl) {
    let match = pageContent.match(/<iframe id="[^"]*" class="vjs_iframe"[^>]+src="([^"]+)"/i);
    if (match) return [this._ensureFullUrl(episodeUrl, match[1]), true];

    match = pageContent.match(/<iframe\s+id="[^"]*uploads\d+"\s+src="([^"]+)"/i);
    if (match) return [this._ensureFullUrl(episodeUrl, match[1]), false];

    match = pageContent.match(/<iframe[^>]+id="[^"]*-js-\d+"[^>]+src="([^"]+)"/i);
    if (match) return [this._ensureFullUrl(episodeUrl, match[1]), false];

    match = pageContent.match(/<iframe[^>]+src="((?:https?:)?\/\/embed\.wcostream\.com\/inc\/embed\/[^"]+)"/i);
    if (match) return [this._ensureFullUrl(episodeUrl, match[1]), false];

    const idx = pageContent.indexOf("onclick=\"myFunction") !== -1 ? pageContent.indexOf("onclick=\"myFunction") : pageContent.indexOf("class=\"episode-descp\"");
    if (idx > 0) {
      const srcMatch = pageContent.slice(idx).match(/src="([^"]+)"/);
      if (srcMatch) return [this._ensureFullUrl(episodeUrl, srcMatch[1]), false];
    }

    const iframeRegex = /<iframe[^>]+src="([^"]+)"/gi;
    const skipHosts = ["ads", "analytics", "disqus", "facebook", "twitter", "check-login"];
    let iframeMatch;
    while ((iframeMatch = iframeRegex.exec(pageContent)) !== null) {
      const url = iframeMatch[1];
      if (skipHosts.some(skip => url.toLowerCase().includes(skip))) continue;
      return [this._ensureFullUrl(episodeUrl, url), false];
    }
    return [null, false];
  }

  _normalizeEmbedPlayerUrl(embedUrl) {
    embedUrl = this._unescapeHtmlUrl(embedUrl);
    if (embedUrl.includes("inc/embed/index.php")) {
      embedUrl = embedUrl.replace("inc/embed/index.php", "inc/embed/video-js.php");
    }
    return embedUrl;
  }

  async _fetchPlayerHtml(embedUrl, episodeUrl) {
    const playerUrl = this._normalizeEmbedPlayerUrl(embedUrl);
    const headers = { Referer: episodeUrl, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
    const playerHtml = await this._makeRequest(playerUrl, "GET", null, headers, false);
    return [playerHtml, playerUrl];
  }

  _buildDirectSource(title, versionType, lang, videoUrl, referer, qualityNum, infoLabel) {
    const videoHeaders = { "User-Agent": this.userAgent, Referer: referer, Accept: "*/*" };
    return {
      release_title: `${title} - ${versionType}`,
      hash: `${videoUrl}|${new URLSearchParams(videoHeaders).toString()}`,
      type: "direct",
      quality: qualityNum,
      debrid_provider: "",
      provider: "wcostream",
      size: "NA",
      seeders: 0,
      byte_size: 0,
      info: [infoLabel],
      lang: lang,
      channel: 3,
      sub: 1,
    };
  }

async _resolveApiUrl(playerHtml, embedUrl) {
    const apiOrigin = this._embedApiOrigin(embedUrl);
    let match = playerHtml.match(/\$\.getJSON\("([^"]+)"\)/);
    if (!match) match = playerHtml.match(/getRedirectedUrl\("([^"]+)"\)/);
    if (match) {
      let path = match[1];
      if (!path.startsWith("http")) {
        path = path.startsWith("/") ? path.slice(1) : path;
        path = new URL(path, apiOrigin).href;
      }
      if (!path.includes("json")) path += (path.includes("?") ? "&json" : "?json");
      return path;
    }
    // Fix: Use a regex that matches the string pattern without problematic escapes
    const getvidlinkRegex = /"(\/inc\/embed\/getvidlink[^"]+)"/;
    match = playerHtml.match(getvidlinkRegex);
    if (match) {
      let path = match[1];
      if (!path.startsWith("http")) path = new URL(path, apiOrigin).href;
      return path;
    }
    return null;
}

  async _extractApiSourcesFromHtml(playerHtml, embedUrl, title, versionType, lang) {
    const sources = [];
    const apiUrl = await this._resolveApiUrl(playerHtml, embedUrl);
    if (!apiUrl) return sources;

    console.log(`[WcoStream] API URL: ${apiUrl}`);
    const apiResp = await this._makeRequest(apiUrl, "GET", null, { Accept: "*/*", Referer: embedUrl, "X-Requested-With": "XMLHttpRequest" }, false);
    if (!apiResp) return sources;

    let jsonData;
    try { jsonData = JSON.parse(apiResp); } catch { return sources; }

    const tokenSd = jsonData.enc || "";
    const tokenHd = jsonData.hd || "";
    const tokenFhd = jsonData.fhd || "";
    let serverBase = jsonData.server || "";
    if (serverBase) serverBase = serverBase.replace(/\/+$/, "") + "/getvid?evid=";

    const qualityMap = [
      ["SD", tokenSd, 1],
      ["HD", tokenHd, 2],
      ["FHD", tokenFhd, 3],
    ];
    for (const [label, token, quality] of qualityMap) {
      if (serverBase && token) {
        const videoUrl = serverBase + token;
        sources.push(this._buildDirectSource(title, versionType, lang, videoUrl, embedUrl, quality, `API ${label} ${versionType}`));
      }
    }

    const cdnBackup = jsonData.cdn || "";
    if (cdnBackup && (tokenSd || tokenHd || tokenFhd)) {
      const backupToken = tokenFhd || tokenHd || tokenSd;
      const backupUrl = cdnBackup.replace(/\/+$/, "") + "/getvid?evid=" + backupToken;
      sources.push(this._buildDirectSource(title, versionType, lang, backupUrl, embedUrl, 2, `CDN Backup ${versionType}`));
    }
    return sources;
  }

  async _extractM3u8SourcesFromHtml(playerHtml, embedUrl, title, versionType, lang) {
    const sources = [];
    const sourceMatch = playerHtml.match(/<source\s+src="([^"]+)"/i);
    if (sourceMatch) {
      sources.push(this._buildDirectSource(title, versionType, lang, sourceMatch[1], embedUrl, 3, `M3U8 ${versionType}`));
      return sources;
    }
    const redirectMatch = playerHtml.match(/getRedirectedUrl\("([^"]+)"/);
    if (redirectMatch) {
      sources.push(this._buildDirectSource(title, versionType, lang, redirectMatch[1], embedUrl, 3, `M3U8 ${versionType}`));
    }
    return sources;
  }

  async _extractJwplayerSourcesFromHtml(playerHtml, embedUrl, title, versionType, lang) {
    const sources = [];
    const sourcesBlock = playerHtml.match(/sources:\s*\[(.*?)\]/s);
    if (!sourcesBlock) return sources;
    const pattern = /\{\s*file:\s*"([^"]+)"(?:,\s*label:\s*"([^"]+)")?/g;
    let match;
    while ((match = pattern.exec(sourcesBlock[1])) !== null) {
      const label = match[2] || "Stream";
      const videoUrl = match[1];
      let quality = 1;
      if (label.includes("1080")) quality = 3;
      else if (label.includes("720")) quality = 2;
      sources.push(this._buildDirectSource(title, versionType, lang, videoUrl, embedUrl, quality, `${label} ${versionType}`));
    }
    return sources;
  }

  async _extractStreamsFromPlayerHtml(playerHtml, embedUrl, title, versionType, lang, isM3u8Player = false) {
    if (playerHtml && playerHtml.includes("high volume of requests")) {
      console.log("[WcoStream] Player blocked due to high volume");
      return [];
    }
    let sources = await this._extractApiSourcesFromHtml(playerHtml, embedUrl, title, versionType, lang);
    if (sources.length) return sources;
    if (isM3u8Player) {
      sources = await this._extractM3u8SourcesFromHtml(playerHtml, embedUrl, title, versionType, lang);
      if (sources.length) return sources;
    }
    sources = await this._extractM3u8SourcesFromHtml(playerHtml, embedUrl, title, versionType, lang);
    if (sources.length) return sources;
    return this._extractJwplayerSourcesFromHtml(playerHtml, embedUrl, title, versionType, lang);
  }

  async _premiumWorkaroundCheck(pageContent, episodeUrl) {
    const playlistMatch = pageContent.match(/href="([^"]*playlist-cat-jw[^"]*)"/);
    if (!playlistMatch) return null;
    let playlistUrl = playlistMatch[1];
    if (!playlistUrl.startsWith("http")) playlistUrl = this._ensureFullUrl(episodeUrl, playlistUrl);
    const playlistResp = await this._makeRequest(playlistUrl);
    if (!playlistResp) return null;
    const rssUrlMatch = playlistResp.match(/<link[^>]*>([^<]+)<\/link>/);
    if (rssUrlMatch) {
      const videoUrl = rssUrlMatch[1].trim();
      if (videoUrl.startsWith("http")) return videoUrl;
    }
    return null;
  }

  async _extractAdvancedSources(episodeUrl, pageContent, versionType, lang, title) {
    const sources = [];
    const premiumUrl = await this._premiumWorkaroundCheck(pageContent, episodeUrl);
    if (premiumUrl) {
      sources.push(this._buildDirectSource(title, versionType, lang, premiumUrl, episodeUrl, 3, `Premium ${versionType}`));
    }
    const [embedUrl, isM3u8Player] = await this._findEmbedUrl(pageContent, episodeUrl);
    if (!embedUrl) {
      console.log("[WcoStream] No embed URL found");
      return sources;
    }
    const [playerHtml, resolvedEmbedUrl] = await this._fetchPlayerHtml(embedUrl, episodeUrl);
    if (!playerHtml) return sources;
    const streamSources = await this._extractStreamsFromPlayerHtml(playerHtml, resolvedEmbedUrl, title, versionType, lang, isM3u8Player);
    sources.push(...streamSources);
    return sources;
  }

  async search(query, dub) {
    const formBody = new URLSearchParams();
    formBody.append("catara", query);
    formBody.append("konuara", "series");
    const resp = await this._makeRequest(`${this.baseUrl}/search`, "POST", formBody.toString());
    if (!resp) return [];
    const $ = cheerio.load(resp);
    const results = [];
    const searchSection = resp.match(/aramamotoru([\s\S]*?)cizgiyazisi/);
    if (searchSection) {
      const section = searchSection[1];
      const linkRegex = /<a href="([^"]+)[^>]*>([^<]+)<\/a>/g;
      let m;
      while ((m = linkRegex.exec(section)) !== null) {
        const href = m[1];
        const title = m[2].trim();
        if (href && title) {
          const url = href.startsWith("/") ? `${this.baseUrl}${href}` : href;
          results.push({ title, url, hasSub: true, hasDub: true });
        }
      }
    } else {
      $(".cerceve").each((_, el) => {
        const titleDiv = $(el).find(".aramadabaslik a");
        const href = titleDiv.attr("href");
        const title = titleDiv.attr("title") || titleDiv.text().trim();
        if (href && title) {
          const fullUrl = href.startsWith("/") ? `${this.baseUrl}${href}` : href;
          results.push({ title, url: fullUrl, hasSub: true, hasDub: true });
        }
      });
    }
    return results;
  }

  async findEpisodes(seriesUrl) {
    const html = await this._fetchHtml(seriesUrl);
    const $ = cheerio.load(html);
    const episodes = [];
    $("a[href*='episode']").each((_, el) => {
      const href = $(el).attr("href");
      const title = $(el).attr("title") || $(el).text().trim();
      if (!href || !title) return;
      const fullUrl = href.startsWith("http") ? href : `${this.baseUrl}${href}`;
      const epNumMatch = title.match(/Episode\s+(\d+(?:\.\d+)?)/i);
      const epNum = epNumMatch ? parseFloat(epNumMatch[1]) : 0;
      const seasonMatch = title.match(/Season\s+(\d+)/i);
      const season = seasonMatch ? parseInt(seasonMatch[1]) : null;
      if (epNum === 0) return;
      episodes.push({
        dataIds: JSON.stringify({
          episodeUrl: fullUrl,
          episodeNumber: epNum,
          season,
          title,
        }),
        number: epNum,
        title,
        season,
      });
    });
    episodes.sort((a, b) => {
      if (a.season !== b.season) return (a.season || 0) - (b.season || 0);
      return a.number - b.number;
    });
    return episodes;
  }

  async findAvailableServers(dataIds, audio) {
    const { episodeUrl, season, episodeNumber, title } = JSON.parse(dataIds);
    const versionType = audio === "dub" ? "DUB" : "SUB";
    const lang = audio === "dub" ? 3 : 2;
    const pageContent = await this._fetchHtml(episodeUrl);
    if (!pageContent) return [];
    const sources = await this._extractAdvancedSources(episodeUrl, pageContent, versionType, lang, title);
    return sources.map((src, idx) => ({
      id: JSON.stringify({
        url: src.hash.split("|")[0],
        headers: Object.fromEntries(new URLSearchParams(src.hash.split("|")[1] || "")),
        quality: src.quality,
        info: src.info,
      }),
      name: `WcoStream - ${src.info[0]}`,
    }));
  }

  async extractStreamFromLinkId(linkId) {
    const { url, headers } = JSON.parse(linkId);
    if (!url) throw new Error("No stream URL");
    return {
      headers: headers || { Referer: this.baseUrl },
      file: url,
      tracks: [],
    };
  }
}
class KickAssAnimeProvider extends BaseProvider {
  constructor() {
    super("KickAssAnime");
    this.baseUrl = "https://kaa.rs/";
    this.apiUrl = "https://kaa.lt/api";
  }

  _getHeaders(referer = this.baseUrl) {
    return {
      "User-Agent": USER_AGENT,
      "Referer": referer,
      "Origin": this.baseUrl,
      "Accept": "application/json, text/plain, */*"
    };
  }

  async _fetchApi(path, options = {}) {
    const url = `${this.apiUrl}${path}`;
    const res = await robustFetch(url, {
      headers: this._getHeaders(),
      ...options
    });
    if (!res.ok) throw new Error(`KickAssAnime API error: ${res.status}`);
    return res.json();
  }

  async search(query, dub) {
    const body = {
      query: query,
      page: 1,
      filters: ""
    };
    const data = await robustFetch(`${this.apiUrl}/fsearch`, {
      method: "POST",
      headers: { ...this._getHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!data.ok) return [];
    const json = await data.json();
    const results = json.result || [];
    return results.map(item => ({
      title: item.title_en || item.title || item.title_original || "Unknown",
      url: item.slug,
      hasSub: true,
      hasDub: true
    }));
  }

  async findEpisodes(seriesUrl) {
    const slug = seriesUrl;
    const data = await this._fetchApi(`/show/${slug}/episodes?lang=en-US`);
    const episodesData = data.result || [];
    episodesData.sort((a, b) => a.episode_number - b.episode_number);
    const episodes = [];
    for (const ep of episodesData) {
      const episodeUrl = `${this.baseUrl}/${slug}/ep-${ep.episode_string}-${ep.slug}`;
      episodes.push({
        dataIds: JSON.stringify({
          episodeUrl,
          episodeNumber: ep.episode_number,
          episodeString: ep.episode_string,
          slug: ep.slug,
          animeSlug: slug
        }),
        number: ep.episode_number,
        title: ep.episode_title || `Episode ${ep.episode_string}`
      });
    }
    return episodes;
  }

  async findAvailableServers(dataIds, audio) {
    const { animeSlug, episodeString, slug } = JSON.parse(dataIds);
    const epData = await this._fetchApi(`/show/${animeSlug}/episode/ep-${episodeString}-${slug}`);
    const servers = epData.servers || [];
    const availableServers = [];
    for (const server of servers) {
      if (server.name === "CatStream" || server.name === "VidStreaming") {
        availableServers.push({
          id: JSON.stringify({
            serverName: server.name,
            serverSrc: server.src,
            animeSlug,
            episodeString,
            slug
          }),
          name: `KickAssAnime - ${server.name}`
        });
      }
    }
    return availableServers;
  }

  async extractStreamFromLinkId(linkId) {
    const { serverName, serverSrc } = JSON.parse(linkId);
    const serverRes = await robustFetch(serverSrc, { headers: this._getHeaders(this.baseUrl) });
    const serverHtml = await serverRes.text();
    const $ = cheerio.load(serverHtml);
    const astroIsland = $('astro-island').first();
    if (!astroIsland.length) throw new Error("No astro-island found");
    const propsAttr = astroIsland.attr('props');
    if (!propsAttr) throw new Error("No props attribute");
    const props = JSON.parse(propsAttr);
    
    let subtitles = [];
    if (props.subtitles && props.subtitles[1]) {
      for (const sub of props.subtitles[1]) {
        subtitles.push({
          label: fixMojibake(sub[1].name[1]),
          file: sub[1].src[1]
        });
      }
    }

    let masterUrl = null;
    let originHeader = "https://krussdomi.com";
    
    if (serverName === "CatStream") {
      let idUrl = props.manifest[1] || props.thumbnails[1];
      if (!idUrl) throw new Error("No manifest/thumbnail URL found");
      const idMatch = idUrl.match(/\/([a-f0-9]+)\//);
      const id = idMatch ? idMatch[1] : null;
      if (!id) throw new Error("Could not extract id from URL");
      masterUrl = `https://bl.krussdomi.com/playlist/${id}/master.m3u8`;
    } else if (serverName === "VidStreaming") {
      const urlParams = new URLSearchParams(serverSrc.split('?')[1]);
      const id = urlParams.get('id');
      if (!id) throw new Error("No id query param");
      masterUrl = `https://hls.krussdomi.com/manifest/${id}/master.m3u8`;
    } else {
      throw new Error(`Unknown server: ${serverName}`);
    }

    const masterRes = await robustFetch(masterUrl, {
      headers: { ...this._getHeaders(), "Origin": originHeader }
    });
    if (!masterRes.ok) throw new Error(`Failed to fetch master.m3u8: ${masterRes.status}`);
    const masterText = await masterRes.text();
    
    const streams = await m3u8Extractor(masterUrl, masterText, { "Origin": originHeader }, subtitles);
    if (!streams.length) throw new Error("No streams found");
    
    const bestStream = streams.reduce((best, curr) => {
      const currRes = parseInt(curr.quality) || 0;
      const bestRes = parseInt(best.quality) || 0;
      return currRes > bestRes ? curr : best;
    }, streams[0]);
    
    const tracks = (bestStream.subtitles || []).map(sub => ({
      file: sub.file,
      label: sub.label,
      kind: "subtitles",
      default: false
    }));
    
    return {
      headers: { Referer: originHeader, Origin: originHeader },
      file: bestStream.url,
      tracks: tracks
    };
  }
}

class NyanimeProvider extends BaseProvider {
  constructor() { super("Nyanime"); this.base = "https://www.nyanime.qzz.io"; this.userAgent = USER_AGENT; this._animeInfoCache = new Map(); }
  async _fetchAnimeInfo(id) {
    if (this._animeInfoCache.has(id)) return this._animeInfoCache.get(id);
    try {
      const res = await robustFetch(`${this.base}/api/aniwatch?action=info&id=${encodeURIComponent(id)}`, { headers: { "User-Agent": this.userAgent } });
      if (!res.ok) return null;
      const data = await res.json();
      const info = data?.data || null;
      if (info) this._animeInfoCache.set(id, info);
      return info;
    } catch { return null; }
  }
  async search(query, dub) {
    const res = await robustFetch(`${this.base}/api/aniwatch?action=search&q=${encodeURIComponent(query)}`, { headers: { "User-Agent": this.userAgent } });
    if (!res.ok) return [];
    const data = await res.json();
    const animes = data?.data?.animes || [];
    let results = animes.map(a => ({ title: a.name || a.title || "Unknown", url: a.id, hasSub: (a.episodes?.sub || 0) > 0, hasDub: (a.episodes?.dub || 0) > 0 }));
    if (dub) results = results.filter(r => r.hasDub);
    return results;
  }
  async findEpisodes(seriesUrl) {
    const animeInfo = await this._fetchAnimeInfo(seriesUrl);
    if (!animeInfo) return [];
    const episodesSub = animeInfo?.episodes?.sub || [];
    const episodesDub = animeInfo?.episodes?.dub || [];
    const allEpisodes = [...episodesSub];
    for (const ep of episodesDub) if (!allEpisodes.some(e => e.number === ep.number)) allEpisodes.push(ep);
    allEpisodes.sort((a,b) => (a.number||0)-(b.number||0));
    return allEpisodes.map(ep => ({ dataIds: JSON.stringify({ episodeId: ep.episodeId, number: ep.number, title: ep.title, id: seriesUrl, animeTitle: animeInfo.name, animeJName: animeInfo.jname || animeInfo.name, totalEpisodes: Math.max(episodesSub.length, episodesDub.length), anilistId: seriesUrl.replace('anilist::','') }), number: ep.number, title: ep.title || `Episode ${ep.number}`, hasSub: episodesSub.some(e=>e.number===ep.number), hasDub: episodesDub.some(e=>e.number===ep.number) }));
  }
  async findAvailableServers(dataIds, audio) {
    const parsed = JSON.parse(dataIds);
    if (!parsed.episodeId) return [];
    return [{ id: JSON.stringify({ episodeId: parsed.episodeId, audio, animeTitle: parsed.animeTitle, animeJName: parsed.animeJName, episodeNo: parsed.number, totalEpisodes: parsed.totalEpisodes, anilistId: parsed.anilistId, id: parsed.id }), name: `Nyanime (${audio.toUpperCase()})` }];
  }
  async extractStreamFromLinkId(linkId) {
    const parsed = JSON.parse(linkId);
    const { episodeId, audio, animeTitle, animeJName, episodeNo, totalEpisodes, anilistId } = parsed;
    let url = `${this.base}/api/aniwatch?action=sources&episodeId=${encodeURIComponent(episodeId)}&category=${audio}&audio=${audio}`;
    if (animeTitle) url += `&title=${encodeURIComponent(animeTitle)}`;
    if (animeJName) url += `&title_ro=${encodeURIComponent(animeJName)}`;
    if (episodeNo) url += `&episodeNo=${episodeNo}`;
    if (totalEpisodes) url += `&totalEpisodes=${totalEpisodes}`;
    if (anilistId) url += `&anilistId=${anilistId}`;
    const res = await robustFetch(url, { headers: { "User-Agent": this.userAgent } });
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const data = await res.json();
    const sources = data?.data?.sources || [];
    const headers = data?.data?.headers || {};
    let bestSource = sources.find(s => s.url && s.url.includes('.m3u8')) || sources[0];
    if (!bestSource) throw new Error("No stream URL");
    return { headers: headers || { Referer: this.base, Origin: this.base }, file: bestSource.url, tracks: [] };
  }
}

// --- P.A.C.K.E.R. unpacker (used by AnifyProvider's FileMoon embeds) ---
class Unbaser {
  constructor(base) {
    this.ALPHABET = {
      62: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
      95: "' !\"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'",
    };
    this.dictionary = {};
    this.base = base;
    if (36 < base && base < 62) this.ALPHABET[base] = this.ALPHABET[base] || this.ALPHABET[62].substr(0, base);
    if (2 <= base && base <= 36) {
      this.unbase = (value) => parseInt(value, base);
    } else {
      try { [...this.ALPHABET[base]].forEach((cipher, index) => { this.dictionary[cipher] = index; }); }
      catch (er) { throw Error("Unsupported base encoding."); }
      this.unbase = this._dictunbaser;
    }
  }
  _dictunbaser(value) {
    let ret = 0;
    [...value].reverse().forEach((cipher, index) => { ret += (Math.pow(this.base, index)) * this.dictionary[cipher]; });
    return ret;
  }
}
function unpack(source) {
  let { payload, symtab, radix, count } = _filterargs(source);
  if (count != symtab.length) throw Error("Malformed p.a.c.k.e.r. symtab.");
  let unbase;
  try { unbase = new Unbaser(radix); } catch (e) { throw Error("Unknown p.a.c.k.e.r. encoding."); }
  function lookup(match) {
    const word = match;
    let word2;
    if (radix == 1) word2 = symtab[parseInt(word)];
    else word2 = symtab[unbase.unbase(word)];
    return word2 || word;
  }
  source = payload.replace(/\b\w+\b/g, lookup);
  return _replacestrings(source);
  function _filterargs(source) {
    const juicers = [
      /}\('(.*)', *(\d+|\[\]), *(\d+), *'(.*)'\.split\('\|'\), *(\d+), *(.*)\)\)/,
      /}\('(.*)', *(\d+|\[\]), *(\d+), *'(.*)'\.split\('\|'\)/,
    ];
    for (const juicer of juicers) {
      const args = juicer.exec(source);
      if (args) {
        let a = args;
        try {
          return { payload: a[1], symtab: a[4].split("|"), radix: parseInt(a[2]), count: parseInt(a[3]) };
        } catch (ValueError) { throw Error("Corrupted p.a.c.k.e.r. data."); }
      }
    }
    throw Error("Could not make sense of p.a.c.k.e.r data (unexpected code structure)");
  }
  function _replacestrings(source) { return source; }
}

class AnifyProvider extends BaseProvider {
  constructor() {
    super("Anify");
    this.base = "https://anify.to";
    this.ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
  }

  _abs(u) {
    if (!u) return "";
    if (/^https?:\/\//i.test(u)) return u;
    return this.base + (u.startsWith("/") ? u : "/" + u);
  }

  async search(query, dub) {
    if (dub) return []; // Anify embeds aren't audio-tagged; treat as sub-only.
    const res = await robustFetch(`${this.base}/search-ajax`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": this.ua, Referer: this.base },
      body: `query=${encodeURIComponent(query)}`,
    });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const results = [];
    const seen = new Set();
    $('a[href^="/anime/"]').each((_, a) => {
      const href = $(a).attr("href");
      if (!href || seen.has(href)) return;
      let title = $(a).find(".animename").first().text().trim();
      if (!title) title = $(a).closest("div,li,article").find(".animename").first().text().trim();
      if (!title) title = ($(a).find("img").attr("alt") || "").trim();
      if (!title) return;
      seen.add(href);
      results.push({ title, url: this.base + href, image: this._abs($(a).find("img").attr("src")), hasSub: true, hasDub: false });
    });
    // Fallback to the reference's raw-HTML regex if the card markup differs.
    if (!results.length) {
      const re = /<a href="([^"]+)">\s*<img src="([^"]+)"[^>]*>\s*<\/a>[\s\S]+?<span class="animename[^"]*"[^>]*>([^<]+)<\/span>/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        results.push({ title: m[3].trim(), url: this.base + m[1].trim(), image: this._abs(m[2].trim()), hasSub: true, hasDub: false });
      }
    }
    return results;
  }

  async findEpisodes(seriesUrl) {
    const res = await robustFetch(seriesUrl, { headers: { "User-Agent": this.ua, Referer: this.base } });
    if (!res.ok) return [];
    const html = await res.text();
    const episodes = [];
    const seen = new Set();
    // Numbered episodes.
    const epRe = /<a href="(\/watch\/[^"]+)">[\s\S]*?<span class="animename">Episode (\d+)<\/span>/g;
    let m;
    while ((m = epRe.exec(html)) !== null) {
      const href = this.base + m[1].trim();
      if (seen.has(href)) continue;
      seen.add(href);
      episodes.push({ dataIds: href, number: parseInt(m[2], 10), title: `Episode ${m[2]}` });
    }
    // Movie / special entries: /watch/.../[ms]-N with a movie|special badge.
    const msRe = /<a href="(\/watch\/[^"]*?\/[ms]-(\d+))"[^>]*>[\s\S]*?<span class="badge badge-(movie|special)"/g;
    while ((m = msRe.exec(html)) !== null) {
      const href = this.base + m[1].trim();
      if (seen.has(href)) continue;
      seen.add(href);
      const number = parseInt(m[2], 10);
      const kind = m[3] === "movie" ? "Movie" : "Special";
      episodes.push({ dataIds: href, number, title: `${kind} ${number}` });
    }
    return episodes.sort((a, b) => a.number - b.number);
  }

  async findAvailableServers(dataIds, audio) {
    const watchUrl = dataIds;
    const res = await robustFetch(watchUrl, { headers: { "User-Agent": this.ua, Referer: this.base } });
    if (!res.ok) throw new Error("Failed to fetch watch page");
    const html = await res.text();

    const iframeUrls = [...html.matchAll(/<iframe\s+src="([^"]+)"[^>]*><\/iframe>/g)].map(x => this._abs(x[1]));
    if (!iframeUrls.length) throw new Error("No iframe source found");

    const servers = [];
    const seen = new Set();
    const push = (url, name, headers) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      servers.push({ id: JSON.stringify({ url, headers }), name });
    };

    for (const iframeUrl of iframeUrls) {
      let ihtml;
      try {
        const ires = await robustFetch(iframeUrl, { headers: { "User-Agent": this.ua, Referer: this.base } });
        if (!ires.ok) continue;
        ihtml = await ires.text();
      } catch { continue; }

      // Streamup: streaming_url : "...m3u8"
      const sm = ihtml.match(/streaming_url\s*:\s*"([^"]+\.m3u8)"/);
      if (sm) {
        push(sm[1], "Streamup", { "User-Agent": this.ua, Referer: "https://strmup.to/", Origin: "https://strmup.to" });
      }

      // Nested iframes -> FileMoon (P.A.C.K.E.R. packed `file: "..."`).
      for (const nm of ihtml.matchAll(/<iframe\s+src="([^"]+)"[^>]*><\/iframe>/g)) {
        try {
          const nres = await robustFetch(nm[1], { headers: { "User-Agent": this.ua, Referer: iframeUrl } });
          if (!nres.ok) continue;
          const nhtml = await nres.text();
          const packed = nhtml.match(/<script[^>]*>\s*(eval\(function\(p,a,c,k,e,d[\s\S]*?)<\/script>/);
          if (!packed) continue;
          const unpacked = unpack(packed[1]);
          const file = unpacked.match(/file:\s*"([^"]+)"/)?.[1];
          push(file, "FileMoon", { "User-Agent": this.ua });
        } catch { /* skip this embed */ }
      }
    }

    if (!servers.length) throw new Error("No streams found");
    return servers;
  }

  async extractStreamFromLinkId(linkId) {
    const { url, headers } = JSON.parse(linkId);
    if (!url) throw new Error("No stream URL");
    return { file: url, headers: headers || { Referer: this.base }, tracks: [] };
  }
}

const allProviders = [
  new MiruroProvider(), new AnikotoProvider(), new AnimeGGProvider(), new AnimeHeavenProvider(),
  new AniDBProvider(), new AniDaoProvider(), new AllAnimeProvider(), new AniNekoProvider(),
  new ReAnimeProvider(), new AniZoneProvider(), new NyanimeProvider(), new SenshiProvider(),
  new AnimetsuProvider(), new AnimeParadiseProvider(), new AnimeverseProvider(), new KickAssAnimeProvider(),
  new WcoStreamProvider(), new AnifyProvider(),
];

async function fetchRawEpisodes(anilistId) {
  const cacheKey = `raw_episodes:${anilistId}`;
  const cached = kvGet(cacheKey);
  if (cached) return cached;
  const gql = `query ($id: Int) { Media(id: $id, type: ANIME) { episodes title { romaji english } } }`;
  const data = await anilistQuery(gql, { id: anilistId });
  const media = data?.Media;
  if (!media) throw new Error("Anime not found");
  const result = { episodes: media.episodes || 0, title: media.title?.english || media.title?.romaji };
  kvPut(cacheKey, result, 7200);
  return result;
}

function injectSourceSlugs(rawData, anilistId) {
  return { ...rawData, anilistId, sources: [] };
}

async function autoGetStreams(animeName, episodeNumber, dub = false) {
  const audio = dub ? "dub" : "sub";
  const timeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

  const results = await Promise.allSettled(
    allProviders.map(async (provider) => {
      try {
        const searchResults = await timeout(provider.search(animeName, dub), 8000);
        if (!searchResults.length) return null;
        const episodes = await timeout(provider.findEpisodes(searchResults[0].url), 8000);
        const episode = episodes.find(ep => ep.number === episodeNumber);
        if (!episode) return null;
        const servers = await timeout(provider.findAvailableServers(episode.dataIds, audio), 8000);
        for (const server of servers) {
          try {
            const stream = await timeout(provider.extractStreamFromLinkId(server.id), 10000);
            if (stream?.file) return { provider: provider.name, serverName: server.name, stream };
          } catch {}
        }
        return null;
      } catch (e) { return null; }
    })
  );
  return results.filter(r => r.status === 'fulfilled' && r.value !== null).map(r => r.value);
}

app.use(compression({ filter: (req, res) => { if (req.headers['x-no-compression']) return false; return compression.filter(req, res); }, threshold: 512 }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public', { maxAge: '1h', etag: false }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.disable('x-powered-by');

app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  return res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/stream', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).json({ error: 'Missing url parameter' });
  try {
    const response = await fetch(videoUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) throw new Error(`Failed to fetch video: ${response.status}`);
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
      res.setHeader('Accept-Ranges', 'bytes');
    }
    res.set('Cache-Control', 'public, max-age=86400');
    const reader = response.body.getReader();
    res.on('close', () => {
      try { reader.cancel(); } catch {}
    });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        await new Promise(resolve => response.body.once('drain', resolve));
      }
    }
    res.end();
  } catch (err) {
    console.error('Stream error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  }
});

app.get('/total-episodes/:anilistId', async (req, res) => {
  const anilistId = parseInt(req.params.anilistId);
  if (isNaN(anilistId)) return res.status(400).json({ error: 'Invalid anilistId' });
  try {
    const query = `query ($id: Int) { Media(id: $id, type: ANIME) { episodes status } }`;
    const data = await anilistQuery(query, { id: anilistId });
    const media = data?.Media;
    if (!media) return res.status(404).json({ error: 'Anime not found' });
    res.json({ totalEpisodes: media.episodes ?? null, status: media.status ?? null, anilistId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/total-episodes-by-title', async (req, res) => {
  const title = req.query.q;
  if (!title) return res.status(400).json({ error: 'Missing q' });
  try {
    const searchQuery = `query ($search: String) { Media(search: $search, type: ANIME) { id episodes status } }`;
    const data = await anilistQuery(searchQuery, { search: title });
    const media = data?.Media;
    if (!media) return res.status(404).json({ error: 'Anime not found' });
    res.json({ totalEpisodes: media.episodes ?? null, status: media.status ?? null, anilistId: media.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/total', async (req, res) => {
  try {
    const anidbProvider = allProviders.find(p => p.name === "AniDB");
    if (!anidbProvider) return res.status(500).json({ error: 'AniDB provider not found' });
    const stats = await anidbProvider.getStats();
    res.json(stats);
  } catch (err) {
    console.error('Error in /total endpoint:', err);
    res.status(500).json({ error: err.message });
  }
});

app.all('*', async (req, res) => {
  const fullUrl = `http://${req.headers.host}${req.originalUrl}`;
  const url = new URL(fullUrl);
  const path = url.pathname;
  const json = (data, status=200) => res.status(status).json(data);
  const error = (msg, status=400) => json({ error: msg }, status);

  try {
    if (path === '/status') {
      const cacheKey = 'status:providers';
      const cached = kvGet(cacheKey);
      if (cached && Date.now() - cached.timestamp < 30000) return json(cached);
      const timeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
      const providerStatuses = await Promise.all(allProviders.map(async p => {
        // Use the provider's own site; no hardcoded fallback host.
        const siteUrl = p.baseUrl || p.base || p.apiBase || p.apiUrl;
        if (!siteUrl) return { name: p.name, online: false };
        // Connectivity check only: can we reach the site and does it respond?
        // Read the response status from the headers; HEAD first, GET as a fallback
        // for hosts that reject HEAD. No hardcoded title/search involved.
        const reachable = async (method) => {
          const res = await timeout(robustFetch(siteUrl, { method, timeout: 3000 }), 4000);
          return !!res && typeof res.status === "number" && res.status < 500;
        };
        try {
          const online = (await reachable("HEAD").catch(() => false))
            || (await reachable("GET").catch(() => false));
          return { name: p.name, online };
        } catch {
          return { name: p.name, online: false };
        }
      }));
      const result = { timestamp: Date.now(), providers: providerStatuses };
      kvPut(cacheKey, result, 30);
      return json(result);
    }
    if (path === '/auto/search') {
      const q = url.searchParams.get('q');
      const dub = url.searchParams.get('dub') === 'true';
      if (!q) return error("Missing q");
      const cacheKey = `search:${q}:${dub}`;
      const cached = kvGet(cacheKey);
      if (cached) return json({ results: cached, cached: true });
      const timeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
      const settled = await Promise.allSettled(allProviders.map(async p =>
        timeout(p.search(q, dub), 6000).then(r => r.map(x => ({ ...x, provider: p.name })))
      ));
      const results = settled.filter(r => r.status === 'fulfilled').flatMap(r => r.value || []);
      kvPut(cacheKey, results, 1800);
      return json({ results });
    }
    if (path === '/auto/episodes') {
      const q = url.searchParams.get('q');
      const dub = url.searchParams.get('dub') === 'true';
      if (!q) return error("Missing q");
      const cacheKey = `episodes:${q}:${dub}`;
      const cached = kvGet(cacheKey);
      if (cached) return json({ ...cached, cached: true });
      const timeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
      try {
        const settled = await Promise.allSettled(allProviders.map(async p =>
          timeout(p.search(q, dub), 5000).then(async r => {
            if (!r.length) throw new Error("no results");
            return { provider: p.name, episodes: await timeout(p._cachedEpisodes(r[0].url), 7000) };
          })
        ));
        const result = settled.find(r => r.status === 'fulfilled' && r.value?.episodes?.length > 0)?.value;
        if (!result) return error("No provider found", 404);
        kvPut(cacheKey, result, 1800);
        return json(result);
      } catch { return error("No provider found", 404); }
    }
    if (path === '/auto/stream') {
      const q = url.searchParams.get('q');
      const ep = parseInt(url.searchParams.get('ep'));
      const dub = url.searchParams.get('dub') === 'true';
      if (!q || isNaN(ep)) return error("Missing q or ep");
      const streams = await autoGetStreams(q, ep, dub);
      if (!streams.length) return error("No working stream", 404);
      return json({ firstWorking: streams[0], allWorkingStreams: streams });
    }
    if (path === '/miruro/search') {
      const q = url.searchParams.get('q');
      if (!q) return error("Missing q");
      const gql = `query ($search: String) { Page(page:1,perPage:20) { media(search:$search,type:ANIME) { id title { romaji english } } } }`;
      const data = await anilistQuery(gql, { search: q });
      return json(data);
    }
    if (path.match(/^\/miruro\/info\/\d+$/)) {
      const id = parseInt(path.split('/')[3]);
      const gql = `query ($id: Int) { Media(id: $id, type: ANIME) { id title { romaji english } format episodes status coverImage { large } } }`;
      const data = await anilistQuery(gql, { id });
      if (!data.Media) return error("Not found", 404);
      return json(data.Media);
    }
    if (path.match(/^\/miruro\/episodes\/\d+$/)) {
      const anilistId = parseInt(path.split('/')[3]);
      const rawData = await fetchRawEpisodes(anilistId);
      const dataWithSlugs = injectSourceSlugs(rawData, anilistId);
      return json(dataWithSlugs);
    }
    if (path.startsWith('/provider/')) {
      const parts = path.split('/');
      const providerName = parts[2];
      const action = parts[3];
      const provider = allProviders.find(p => p.name.toLowerCase() === providerName.toLowerCase());
      if (!provider) return error("Provider not found", 404);
      if (providerName.toLowerCase() === 'anidb' && action === 'stats') {
        const stats = await provider.getStats();
        return json(stats);
      }
      if (action === 'search') {
        const q = url.searchParams.get('q');
        const dub = url.searchParams.get('dub') === 'true';
        if (!q) return error("Missing q");
        return json(await provider.search(q, dub));
      }
      if (action === 'episodes') {
        const seriesUrl = url.searchParams.get('url');
        if (!seriesUrl) return error("Missing url");
        return json(await provider.findEpisodes(seriesUrl));
      }
      if (action === 'servers') {
        const dataIds = url.searchParams.get('dataIds');
        const audio = url.searchParams.get('audio');
        if (!dataIds || !audio) return error("Missing dataIds or audio");
        return json(await provider.findAvailableServers(dataIds, audio));
      }
      if (action === 'stream') {
        const linkId = url.searchParams.get('linkId');
        if (!linkId) return error("Missing linkId");
        return json(await provider.extractStreamFromLinkId(linkId));
      }
      return error("Invalid action", 404);
    }
    return error("Not found", 404);
  } catch (err) {
    console.error(err);
    return error(err.message, 500);
  }
});

app.listen(PORT, () => console.log(`Anime proxy server running on port ${PORT}`));