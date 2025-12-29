import { Request } from "express";
import {
  TorrentCategory,
  TorrentSearchResult,
  TorrentSource,
  searchTorrents,
} from "../torrent/search.js";
import { getTorrentInfo } from "../torrent/webtorrent.js";
import { getReadableSize, isSubtitleFile, isVideoFile } from "../utils/file.js";
import { guessLanguages } from "../utils/language.js";
import { guessQuality, rateTorrent } from "../utils/quality.js";
import { getTmdbTitleFromWeb, normalizeTmdbTitle } from "../utils/tmdb.js";
import { matchEpisodePatterns } from "../utils/shows.js";
import crypto from "crypto";
import { log } from "../utils/logger.js";

interface HandlerArgs {
  type: string;
  id: string;
  config?: {
    enableJackett: string;
    jackettUrl: string;
    jackettKey: string;
    enableNcore: string;
    nCoreUser: string;
    nCorePassword: string;
    enableInsane: string;
    insaneUser: string;
    insanePassword: string;
    enableItorrent: string;
    enableYts: string;
    enableEztv: string;
    hideEnglishIfHun: string;
    disableHdr: string;
    disableHevc: string;
    disable4k: string;
    disableCam: string;
    disable3d: string;
  };
  req: Request;
}

type StreamItem = Awaited<ReturnType<typeof getStreamsFromTorrent>>[number];

const dedupeTorrents = (torrents: TorrentSearchResult[]) => {
  const map = new Map<string, TorrentSearchResult>();
  for (const t of torrents) {
    map.set(`${t.tracker}:${t.name}`, t);
  }
  return Array.from(map.values());
};

function isFreeleechTorrent(torrent: TorrentSearchResult): boolean {
  const anyTorrent = torrent as any;
  const lower = torrent.name.toLowerCase();

  if (anyTorrent.freeleech === true || anyTorrent.isFreeleech === true) return true;
  if (/\bfreeleech\b/.test(lower)) return true;
  if (/\bfl\b/.test(lower)) return true;

  return false;
}

function detectSeasonPack(name: string, season?: string) {
  if (!season) return false;

  const lower = name.toLowerCase();
  const s = Number(season);
  const s2 = season.padStart(2, "0");

  const hasEpisodeToken = /(\be\d{1,2}\b|\bep?\s?\d{1,2}\b)/i.test(lower);
  const hasSeasonToken =
    lower.includes(`s${s}`) ||
    lower.includes(`s${s2}`) ||
    lower.includes(`${s}evad`) ||
    lower.includes(`${s2}evad`) ||
    lower.includes(`evad${s}`) ||
    lower.includes(`evad${s2}`) ||
    lower.includes(`season ${s}`) ||
    lower.includes(`season${s}`);

  if (hasSeasonToken && !hasEpisodeToken) return true;
  if (/\b(complete|season pack|pack)\b/i.test(lower)) return true;

  return false;
}

function extractHunFlags(languageLabel: string) {
  return {
    hasHunAudio: languageLabel.includes(" HUN"),
    hasHunSub: false,
  };
}

const isAllowedQuality = (config: HandlerArgs["config"], quality: string) => {
  if (config?.disable4k === "on" && quality.includes("4K")) return false;
  if (config?.disableCam === "on" && quality.includes("CAM")) return false;

  if (
    config?.disableHdr === "on" &&
    (quality.includes("HDR") || quality.includes("Dolby Vision"))
  ) {
    return false;
  }

  if (config?.disable3d === "on" && quality.includes("3D")) return false;

  return true;
};

const isAllowedFormat = (config: HandlerArgs["config"], name: string) => {
  if (config?.disableHevc === "on") {
    const str = name.replace(/\W/g, "").toLowerCase();
    if (str.includes("x265") || str.includes("h265") || str.includes("hevc")) {
      return false;
    }
  }
  return true;
};

function parseStremioId(id: string) {
  const parts = id.split(":");

  let imdbId: string | null = null;
  let tmdbId: string | null = null;
  let season: string | undefined;
  let episode: string | undefined;

  if (parts[0].startsWith("tt")) {
    imdbId = parts[0];
    season = parts[1];
    episode = parts[2];
  } else if (parts[0] === "tmdb") {
    tmdbId = parts[1];
    season = parts[2];
    episode = parts[3];
  } else {
    imdbId = parts[0];
    season = parts[1];
    episode = parts[2];
  }

  return { imdbId, tmdbId, season, episode };
}

function buildSources(config?: HandlerArgs["config"]): TorrentSource[] {
  const sources: TorrentSource[] = [];
  if (config?.enableJackett === "on") sources.push("jackett");
  if (config?.enableNcore === "on") sources.push("ncore");
  if (config?.enableInsane === "on") sources.push("insane");
  if (config?.enableItorrent === "on") sources.push("itorrent");
  if (config?.enableYts === "on") sources.push("yts");
  if (config?.enableEztv === "on") sources.push("eztv");
  return sources;
}

function buildCategories(type: string): TorrentCategory[] {
  const categories: TorrentCategory[] = [];
  if (type === "movie") categories.push("movie");
  if (type === "series") categories.push("show");
  return categories;
}

function filterEpisodeTorrentName(
  torrent: TorrentSearchResult,
  season?: string,
  episode?: string
): boolean {
  if (!season || !episode) return true;

  const s = Number(season);
  const e = Number(episode);

  const lower = torrent.name.toLowerCase();
  const hasEpisodeToken = lower.match(/e\d{1,2}/);

  const hasSeason =
    lower.includes(`s${s}`) ||
    lower.includes(`s${season.padStart(2, "0")}`) ||
    lower.includes(`${s}evad`) ||
    lower.includes(`${season.padStart(2, "0")}evad`) ||
    lower.includes(`evad${s}`) ||
    lower.includes(`evad${season.padStart(2, "0")}`);

  if (hasSeason && !hasEpisodeToken) return true;

  return matchEpisodePatterns(torrent.name, s, e);
}

function computeTorrentScore(
  torrent: TorrentSearchResult,
  season: string | undefined,
  isEpisode: boolean
) {
  const languageLabel = guessLanguages(torrent.name, torrent.category);
  const { hasHunAudio, hasHunSub } = extractHunFlags(languageLabel);

  return rateTorrent({
    name: torrent.name,
    seeds: torrent.seeds,
    peers: torrent.peers,
    sizeBytes: torrent.size,
    source: torrent.tracker,
    hasHunAudio,
    hasHunSub,
    isFreeleech: isFreeleechTorrent(torrent),
    isSeasonPack: detectSeasonPack(torrent.name, season),
    isEpisode,
  });
}

export const streamHandler = async ({ type, id, config, req }: HandlerArgs) => {
  const categories = buildCategories(type);
  const sources = buildSources(config);

  const { imdbId, tmdbId, season, episode } = parseStremioId(id);
  const isTmdb = Boolean(tmdbId);
  const isEpisode = Boolean(season && episode);

  log("Search request:", "imdbId= <", imdbId, ">", "tmdbId= <", tmdbId, ">");

  let tmdbTitle: string | null = null;
  if (isTmdb && tmdbId) {
    const rawTitle = await getTmdbTitleFromWeb(tmdbId);
    if (rawTitle) tmdbTitle = normalizeTmdbTitle(rawTitle);
  }

  const queries: string[] = [];
  if (!isTmdb && imdbId) queries.push(imdbId);
  if (isTmdb && tmdbTitle) queries.push(tmdbTitle);

  const finalQueries = queries.filter((q) => q && q.length > 0);

  const results = (
    await Promise.all(
      finalQueries.map((query) =>
        searchTorrents(query, {
          categories,
          sources,
          jackett: { url: config?.jackettUrl, apiKey: config?.jackettKey },
          ncore: { user: config?.nCoreUser, password: config?.nCorePassword },
          insane: { user: config?.insaneUser, password: config?.insanePassword },
        })
      )
    )
  ).flat();

  const torrents = dedupeTorrents(results);

  const torrentsScored = torrents.map((t) => ({
    torrent: t,
    torrentScore: computeTorrentScore(t, season, isEpisode),
  }));

  torrentsScored.sort((a, b) => {
    if (b.torrentScore !== a.torrentScore) return b.torrentScore - a.torrentScore;
    return (b.torrent.seeds || 0) - (a.torrent.seeds || 0);
  });

  const filteredTorrents = torrentsScored.filter(({ torrent }) => {
    if (!torrent.seeds) return false;
    if (torrent.category?.includes("DVD")) return false;
    if (!isAllowedFormat(config, torrent.name)) return false;
    if (!isAllowedQuality(config, guessQuality(torrent.name).quality)) return false;
    if (!filterEpisodeTorrentName(torrent, season, episode)) return false;
    return true;
  });

  let streams: StreamItem[] = (
    await Promise.all(
      filteredTorrents.map(({ torrent, torrentScore }) =>
        getStreamsFromTorrent(req, torrent, id, season, episode, torrentScore)
      )
    )
  ).flat();

  streams = streams.filter((s) => {
    if (!isAllowedFormat(config, s.fileName)) return false;
    if (!isAllowedQuality(config, s.quality)) return false;
    return true;
  });

  {
    const map = new Map<string, StreamItem>();
    for (const s of streams) {
      const key = s.stream?.url || "";
      if (!key) continue;

      const prev = map.get(key);
      if (!prev || s.score > prev.score) map.set(key, s);
    }
    streams = Array.from(map.values());

    const hasAnyHun = streams.some((s) =>
      guessLanguages(s.torrentName, s.torrentCategory).includes(" HUN")
    );

    if (config?.hideEnglishIfHun === "on") {
      const hasAnyHun = streams.some((s) =>
        guessLanguages(s.torrentName).includes(" HUN")
     );

     if (hasAnyHun) {
      streams = streams.filter((s) => {
      const label = guessLanguages(s.torrentName, s.torrentCategory);
      const hasHun = label.includes(" HUN");
      const hasEng = label.includes(" ENG");
      return hasHun || !hasEng;
      });
     }
    }
  };

  streams.sort((a, b) => b.score - a.score);

  if (streams.length > 0) {
    const top = streams[0];
    const desc = top.stream.description || "";
    top.stream.description = ["★ Ajánlott", desc].filter(Boolean).join("\n");
  }

  return { streams: streams.map((s) => s.stream) };
};

export async function getStreamsFromTorrent(
  req: Request,
  torrent: TorrentSearchResult,
  id: string,
  season?: string,
  episode?: string,
  torrentScore: number = 0
) {
  const uri = torrent.torrent || torrent.magnet;
  if (!uri) return [];

  const torrentInfo = await getTorrentInfo(uri);
  if (!torrentInfo) return [];

  let videos = torrentInfo.files.filter((file) => isVideoFile(file.name));

  if (season && episode) {
    const s = Number(season);
    const e = Number(episode);

    const matched = videos.filter((file) => matchEpisodePatterns(file.name, s, e));
    if (matched.length > 0) videos = matched;
  }

  if (videos.length > 1) {
    if (season && episode) {
      videos.sort((a, b) => b.size - a.size);
      videos = [videos[0]];
    } else {
      const maxSize = Math.max(...videos.map((f) => f.size));
      const threshold = maxSize * 0.7;
      videos = videos.filter((f) => f.size >= threshold);
    }
  }

  const subs = torrentInfo.files.filter((file) => isSubtitleFile(file.name));

  const torrentQuality = guessQuality(torrent.name);
  const languages = guessLanguages(torrent.name, torrent.category);

  function stremioLangFromLabel(label: string): string {
    if (label.includes("HUN")) return "hun";
    if (label.includes("ENG")) return "eng";
    if (label.includes("GER")) return "de";
    if (label.includes("FRE")) return "fr";
    if (label.includes("ITA")) return "it";
    if (label.includes("SPA")) return "es";
    if (label.includes("RUS")) return "ru";
    if (label.includes("MULTI")) return "und";
    return "und";
  }

  return videos.map((file) => {
    const fileQuality = guessQuality(file.name);
    const bestQuality = fileQuality.score > torrentQuality.score ? fileQuality : torrentQuality;

    const description = [
      ...(season && episode
        ? [
            torrent.name,
            `Season:${season.padStart(2, "0")} Episode:${episode.padStart(2, "0")}`,
          ]
        : [torrent.name]),
      ` ${getReadableSize(file.size)} ${languages}`,
      `⚙️ ${torrent.tracker}  ⬆️ ${torrent.seeds}  ⬇️ ${torrent.peers}`,
    ].join("\n");

    const base = `${req.protocol}://${req.get("host")}/stream`;
    const url = [base, encodeURIComponent(uri), encodeURIComponent(file.path)].join("/");

    const subtitles = subs.map((sub, index) => ({
      id: index.toString(),
      url: [base, encodeURIComponent(uri), encodeURIComponent(sub.path)].join("/"),
      lang: stremioLangFromLabel(guessLanguages(sub.name)),
    }));

    const cleanPath = file.path.split("/").pop() || file.path;
    const videoHash = crypto.createHash("md5").update(id).digest("hex");

    const finalScore = torrentScore + bestQuality.score / 1000;

    return {
      stream: {
        name: bestQuality.quality,
        description,
        url,
        subtitles,
        behaviorHints: {
          bingeGroup: torrent.name,
          filename: cleanPath,
          videoHash,
          notWebReady: true,
          videoSize: file.size,
        },
      },
      torrentName: torrent.name,
      fileName: file.name,
      torrentCategory: torrent.category,
      quality: bestQuality.quality,
      score: finalScore,
    };
  });
}
