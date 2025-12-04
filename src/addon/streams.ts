import { Request } from "express";
import Stremio from "stremio-addon-sdk";
import {
  TorrentCategory,
  TorrentSearchResult,
  TorrentSource,
  searchTorrents,
} from "../torrent/search.js";
import { getTorrentInfo } from "../torrent/webtorrent.js";
import { getReadableSize, isSubtitleFile, isVideoFile } from "../utils/file.js";
import { guessLanguages } from "../utils/language.js";
import { guessQuality } from "../utils/quality.js";
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
    disableHdr: string;
    disableHevc: string;
    disable4k: string;
    disableCam: string;
    disable3d: string;
  };
  req: Request;
}

export const streamHandler = async ({ type, id, config, req }: HandlerArgs) => {
  let torrents: TorrentSearchResult[] = [];

  const categories: TorrentCategory[] = [];
  if (type === "movie") categories.push("movie");
  if (type === "series") categories.push("show");

  const sources: TorrentSource[] = [];
  if (config?.enableJackett === "on") sources.push("jackett");
  if (config?.enableNcore === "on") sources.push("ncore");
  if (config?.enableInsane === "on") sources.push("insane");
  if (config?.enableItorrent === "on") sources.push("itorrent");
  if (config?.enableYts === "on") sources.push("yts");
  if (config?.enableEztv === "on") sources.push("eztv");

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

  const isTmdb = !!tmdbId;

  log(
    "Search request:",
    "imdbId= <", imdbId, ">",
    "tmdbId= <", tmdbId, ">"
  );

  let tmdbTitle: string | null = null;

  if (isTmdb && tmdbId) {
    const rawTitle = await getTmdbTitleFromWeb(tmdbId);

    if (rawTitle) {
      tmdbTitle = normalizeTmdbTitle(rawTitle);
    }
  }

  const queries: string[] = [];

  // IMDb alapú keresés – csak ID
  if (!isTmdb && imdbId) {
    queries.push(imdbId);
  }

  // TMDB alapú keresés – csak a cím
  if (isTmdb && tmdbTitle) {
    queries.push(tmdbTitle);
  }

  const finalQueries = queries.filter(q => q && q.length > 0);

  torrents = (
    await Promise.all(
      finalQueries.map((query) =>
        searchTorrents(query, {
          categories,
          sources,
          jackett: {
            url: config?.jackettUrl,
            apiKey: config?.jackettKey,
          },
          ncore: {
            user: config?.nCoreUser,
            password: config?.nCorePassword,
          },
          insane: {
            user: config?.insaneUser,
            password: config?.insanePassword,
          },
        })
      )
    )
  ).flat();

  torrents = dedupeTorrents(torrents);

  torrents.sort((a, b) => {
    const qa = guessQuality(a.name).score;
    const qb = guessQuality(b.name).score;

    if (qb !== qa) return qb - qa;

    return (a.size || 0) - (b.size || 0);
  });

  torrents = torrents.filter((torrent) => {
    if (!torrent.seeds) return false;
    if (torrent.category?.includes("DVD")) return false;
    if (!isAllowedFormat(config, torrent.name)) return false;
    if (!isAllowedQuality(config, guessQuality(torrent.name).quality)) return false;

    if (season && episode) {
      const s = Number(season);
      const e = Number(episode);

      const lower = torrent.name.toLowerCase();

      const hasEpisode = lower.match(/e\d{1,2}/);

      const hasSeason =
        lower.includes(`s${s}`) ||
        lower.includes(`s${season.padStart(2, "0")}`) ||
        lower.includes(`${s}evad`) ||
        lower.includes(`${season.padStart(2, "0")}evad`) ||
        lower.includes(`evad${s}`) ||
        lower.includes(`evad${season.padStart(2, "0")}`);

      if (hasSeason && !hasEpisode) {
        return true;
      }

      if (!matchEpisodePatterns(torrent.name, s, e)) {
        return false;
      }
    }

    return true;
  });

  let streams = (
    await Promise.all(
      torrents.map((torrent) =>
        getStreamsFromTorrent(req, torrent, id, season, episode)
      )
    )
  ).flat();

  streams = streams.filter((stream) => {
    if (!isAllowedFormat(config, stream.fileName)) return false;
    if (!isAllowedQuality(config, stream.quality)) return false;
    return true;
  });

  streams.sort((a, b) => b.score - a.score);

  return { streams: streams.map((stream) => stream.stream) };
};

const dedupeTorrents = (torrents: TorrentSearchResult[]) => {
  const map = new Map(
    torrents.map((torrent) => [`${torrent.tracker}:${torrent.name}`, torrent])
  );

  return [...map.values()];
};

export const getStreamsFromTorrent = async (
  req: Request,
  torrent: TorrentSearchResult,
  id: string,
  season?: string,
  episode?: string
) => {
  const uri = torrent.torrent || torrent.magnet;
  if (!uri) return [];

  const torrentInfo = await getTorrentInfo(uri);
  if (!torrentInfo) return [];

  let videos = torrentInfo.files.filter((file) => isVideoFile(file.name));

  if (season && episode) {
    const s = Number(season);
    const e = Number(episode);

    const matched = videos.filter((file) =>
      matchEpisodePatterns(file.name, s, e)
    );

    if (matched.length > 0) {
      videos = matched;
    }
  }

  if (videos.length > 1) {
    const maxSize = Math.max(...videos.map(f => f.size));
    const threshold = maxSize * 0.7;
    videos = videos.filter(f => f.size >= threshold);
  }

  const subs = torrentInfo.files.filter((file) => isSubtitleFile(file.name));

  const torrentQuality = guessQuality(torrent.name);
  const languages = guessLanguages(torrent.name, torrent.category);

  return videos.map((file) => {
    const fileQuality = guessQuality(file.name);
    const { quality, score } =
      fileQuality.score > torrentQuality.score ? fileQuality : torrentQuality;

    const description = [
      ...(season && episode
        ? [torrent.name, `Season:${season.padStart(2, "0")} Episode:${episode.padStart(2, "0")}`]
        : [torrent.name]),
      ` ${getReadableSize(file.size)} ${languages}`,
      `⚙️ ${torrent.tracker}  ⬆️ ${torrent.seeds}  ⬇️ ${torrent.peers}`,
    ].join("\n");

    const base = `${req.protocol}://${req.get("host")}/stream`;

    const url = [
      base,
      encodeURIComponent(uri),
      encodeURIComponent(file.path),
    ].join("/");

    const subtitles = subs.map((sub, index) => ({
      id: index.toString(),
      url: [
        base,
        encodeURIComponent(uri),
        encodeURIComponent(sub.path),
      ].join("/"),
      lang: sub.name,
    }));

    const cleanPath = file.path.split("/").pop() || file.path;
    const videoHash = crypto.createHash("md5").update(id).digest("hex");

    return {
      stream: {
        name: quality,
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
      quality,
      score,
    };
  });
};

const isAllowedQuality = (config: HandlerArgs["config"], quality: string) => {
  if (config?.disable4k === "on" && quality.includes("4K")) return false;
  
  if (config?.disableCam === "on" && quality.includes("CAM")) return false;

  if (
    config?.disableHdr === "on" &&
    (quality.includes("HDR") || quality.includes("Dolby Vision"))
  )
    return false;

  if (config?.disable3d === "on" && quality.includes("3D")) return false;
  
  return true;
};

const isAllowedFormat = (config: HandlerArgs["config"], name: string) => {
  if (config?.disableHevc === "on") {
    const str = name.replace(/\W/g, "").toLowerCase();
    if (str.includes("x265") || str.includes("h265") || str.includes("hevc"))
      return false;
  }

  return true;
};
