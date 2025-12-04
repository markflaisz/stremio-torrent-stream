import { Router } from "express";
import { searchTorrents } from "./torrent/search.js";
import {
  getFile,
  getOrAddTorrent,
  getStats,
  getTorrentInfo,
  streamClosed,
  streamOpened,
} from "./torrent/webtorrent.js";
import { getStreamingMimeType } from "./utils/file.js";
import { log, dedupedLog } from "./utils/logger.js";

export const router = Router();

router.get("/stats", (req, res) => {
  const stats = getStats();
  res.json(stats);
});

router.get("/torrents/:query", async (req, res) => {
  const { query } = req.params;
  const torrents = await searchTorrents(query);
  res.json(torrents);
});

router.post("/torrents/:query", async (req, res) => {
  const { query } = req.params;
  const options = req.body;
  const torrents = await searchTorrents(query, options);
  res.json(torrents);
});

router.get("/torrent/:torrentUri", async (req, res) => {
  const { torrentUri } = req.params;

  const torrent = await getTorrentInfo(torrentUri);
  if (!torrent) return res.status(500).send("Failed to get torrent");

  torrent.files.forEach((file) => {
    file.url = [
      `${req.protocol}://${req.get("host")}`,
      "stream",
      encodeURIComponent(torrentUri),
      encodeURIComponent(file.path),
    ].join("/");
  });

  res.json(torrent);
});

router.get("/stream/:torrentUri/:filePath", async (req, res) => {
  const headerRange = req.headers.range;
  const range = typeof headerRange === "string" ? headerRange : undefined;
  dedupedLog(`Stream request: ${req.originalUrl} | Range: ${range ? range : "NONE"}`);

  const { torrentUri, filePath } = req.params;

  const torrent = await getOrAddTorrent(torrentUri);
  if (!torrent) return res.status(500).send("Failed to add torrent");

  const file = getFile(torrent, filePath);
  if (!file) return res.status(404).send("File not found");

  if (!range) {
    const headers = {
      "Content-Length": file.length,
      "Content-Type": getStreamingMimeType(file.name),
      "Accept-Ranges": "bytes",
    };

    res.writeHead(200, headers);

    try {
      const videoStream = file.createReadStream();

      videoStream.on("error", (error) => {
        //log(`Stream error (no-range): ${error?.message || error}`);
      });

      res.on("close", () => {
        //log(`Stream closed by client (no-range): ${torrent.infoHash} | ${file.name}`);
        streamClosed(torrent.infoHash, file.name);
      });

      streamOpened(torrent.infoHash, file.name);

      videoStream.pipe(res);
    } catch (error) {
      //log(`Stream exception (no-range): ${error}`);
      if (!res.headersSent) {
        res.status(500).end();
      }
    }
    return;
  }

  const positions = range.replace(/bytes=/, "").split("-");
  const start = Number(positions[0]);
  const end = Number(positions[1]) || file.length - 1;

  if (start >= file.length || end >= file.length) {
    res.writeHead(416, {
      "Content-Range": `bytes */${file.length}`,
    });
    return res.end();
  }

  const headers = {
    "Content-Range": `bytes ${start}-${end}/${file.length}`,
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    "Content-Type": getStreamingMimeType(file.name),
  };

  res.writeHead(206, headers);

  try {
    const videoStream = file.createReadStream({ start, end });

    videoStream.on("error", (error) => {
      //log(`Stream error: ${error?.message || error}`);
    });

    res.on("close", () => {
      //log(`Stream closed by client: ${torrent.infoHash} | ${file.name}`);
      streamClosed(torrent.infoHash, file.name);
    });
    streamOpened(torrent.infoHash, file.name);
    videoStream.pipe(res);
  } 
  catch (error) {
    //log(`Stream exception: ${error}`);
    if (!res.headersSent) {
      res.status(500).end();
    } else {
    }
  }
});
