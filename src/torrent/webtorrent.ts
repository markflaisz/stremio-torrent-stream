import fs from "fs-extra";
import MemoryStore from "memory-chunk-store";
import os from "os";
import path from "path";
import WebTorrent, { Torrent } from "webtorrent";
import { getReadableDuration } from "../utils/file.js";

interface FileInfo {
  name: string;
  path: string;
  size: number;
  url?: string;
}

interface ActiveFileInfo extends FileInfo {
  progress: number;
  downloaded: number;
}

export interface TorrentInfo {
  name: string;
  infoHash: string;
  size: number;
  files: FileInfo[];
}

interface ActiveTorrentInfo extends TorrentInfo {
  progress: number;
  downloaded: number;
  uploaded: number;
  downloadSpeed: number;
  uploadSpeed: number;
  peers: number;
  openStreams: number;
  files: ActiveFileInfo[];
}

// Timezone-based logging with proper timestamp placement
import { log, dedupedLog } from "../utils/logger.js";

// Directory to store torrent files
const TORRENT_DIR =
  process.env.TORRENT_DIR || path.join(process.cwd(), "torrents");
fs.ensureDirSync(TORRENT_DIR);

// Directory to store downloaded files
const DOWNLOAD_DIR =
  process.env.DOWNLOAD_DIR || path.join(process.cwd(), "downloads");
fs.ensureDirSync(DOWNLOAD_DIR);

// Maximum number of connections per torrent (default 50)
const MAX_CONNS_PER_TORRENT = Number(process.env.MAX_CONNS_PER_TORRENT) || 50;

// Max download speed (MB/s) over all torrents (default 20MB/s)
const DOWNLOAD_SPEED_LIMIT =
  (Number(process.env.DOWNLOAD_SPEED_MBPS) || 20) * 1024 * 1024;

// Max upload speed (MB/s) over all torrents (default 1MB/s)
const UPLOAD_SPEED_LIMIT =
  (Number(process.env.UPLOAD_SPEED_MBPS) || 1) * 1024 * 1024;

// Time (hour) to seed torrents after all streams are closed (default 48 hour)
  const SEED_TIME =
  (Number(process.env.SEED_TIME_HOURS) || 48) * 60 * 60 * 1000;

// Timeout (sec) when adding torrents if no metadata is received (default 5 seconds)
const TORRENT_TIMEOUT =
  (Number(process.env.TORRENT_TIMEOUT_SECONDS) || 5) * 1000;

const infoClient = new WebTorrent();
const streamClient = new WebTorrent({
  // @ts-ignore
  downloadLimit: DOWNLOAD_SPEED_LIMIT,
  uploadLimit: UPLOAD_SPEED_LIMIT,
  maxConns: MAX_CONNS_PER_TORRENT,
});

streamClient.on("torrent", (torrent) => {
  //log(`Added torrent: ${torrent.name}`);
});

streamClient.on("error", (error) => {
  if (typeof error === "string") {
    console.error(`Error: ${error}`);
  } else {
    if (error.message.startsWith("Cannot add duplicate torrent")) return;
    console.error(`Error: ${error.message}`);
  }
});

infoClient.on("error", () => {});

const launchTime = Date.now();

export const getStats = () => ({
  uptime: getReadableDuration(Date.now() - launchTime),
  openStreams: [...openStreams.values()].reduce((a, b) => a + b, 0),
  downloadSpeed: streamClient.downloadSpeed,
  uploadSpeed: streamClient.uploadSpeed,
  activeTorrents: streamClient.torrents.map<ActiveTorrentInfo>((torrent) => ({
    name: torrent.name,
    infoHash: torrent.infoHash,
    size: torrent.length,
    progress: torrent.progress,
    downloaded: torrent.downloaded,
    uploaded: torrent.uploaded,
    downloadSpeed: torrent.downloadSpeed,
    uploadSpeed: torrent.uploadSpeed,
    peers: torrent.numPeers,
    openStreams: openStreams.get(torrent.infoHash) || 0,
    files: torrent.files.map((file) => ({
      name: file.name,
      path: file.path,
      size: file.length,
      progress: file.progress,
      downloaded: file.downloaded,
    })),
  })),
});

let timeout: NodeJS.Timeout;
export const getOrAddTorrent = (uri: string) =>
  new Promise<Torrent | undefined>((resolve) => {
    const torrent = streamClient.add(
      uri,
      {
        path: DOWNLOAD_DIR,
        destroyStoreOnDestroy: false,
        // @ts-ignore
        deselect: true,
      },
      (torrent) => {
        clearTimeout(timeout);
        const infoHash = torrent.infoHash;
        const filePath = path.join(TORRENT_DIR, `${infoHash}.torrent`);
        const metaPath = path.join(TORRENT_DIR, `${infoHash}.json`);
        
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, torrent.torrentFile);
          log(`.torrent file saved: ${filePath}`);
        }

        if (!fs.existsSync(metaPath)) {
          const addedAt = Date.now();
          try {
          fs.writeJsonSync(metaPath, { addedAt });
          log(`Metadata saved: ${metaPath}`);
          } 
          catch (e) { 
            log(`Failed to save metadata for ${infoHash}: ${e}`);
          }
        }
        resolve(torrent);
      }
    );

    timeout = setTimeout(() => {
      torrent.destroy();
      resolve(undefined);
    }, TORRENT_TIMEOUT);
  });

export const getFile = (torrent: Torrent, path: string) =>
  torrent.files.find((file) => file.path === path);

export const getTorrentInfo = async (uri: string) => {
  const getInfo = (torrent: Torrent): TorrentInfo => ({
    name: torrent.name,
    infoHash: torrent.infoHash,
    size: torrent.length,
    files: torrent.files.map((file) => ({
      name: file.name,
      path: file.path,
      size: file.length,
    })),
  });
  
  let timeout: NodeJS.Timeout;
  return await new Promise<TorrentInfo | undefined>((resolve) => {
    const torrent = infoClient.add(
      uri,
      { store: MemoryStore, destroyStoreOnDestroy: false },
      (torrent) => {
        clearTimeout(timeout);
        const info = getInfo(torrent);
        //dedupedLog(`fetched:${torrent.infoHash}`, `Fetched info: ${info.name}`);
        torrent.destroy();
        resolve(info);
      }
    );

    timeout = setTimeout(() => {
      torrent.destroy();
      resolve(undefined);
    }, TORRENT_TIMEOUT);
  });
};

const timeouts = new Map<string, NodeJS.Timeout>();
const openStreams = new Map<string, number>();

export const streamOpened = (hash: string, fileName: string) => {
  const count = openStreams.get(hash) || 0;
  openStreams.set(hash, count + 1);

  const timeout = timeouts.get(hash);
  if (timeout) {
    clearTimeout(timeout);
    timeouts.delete(hash);
  }
};

export const streamClosed = (hash: string, fileName: string) => {
  const count = openStreams.get(hash) || 1;
  openStreams.set(hash, count - 1);

  if (count > 1) return;

  openStreams.delete(hash);

  let timeout = timeouts.get(hash);
  if (timeout) return;

  timeout = setTimeout(async () => {
    const torrent = streamClient.get(hash);
    // @ts-ignore
    torrent?.destroy(undefined, () => {
      log(`Removed torrent: ${torrent.name}`);
      timeouts.delete(hash);
    });
  }, SEED_TIME);

  timeouts.set(hash, timeout);
};

export const restoreSavedTorrents = () => {
  const files = fs.readdirSync(TORRENT_DIR);

  const torrentFiles = files.filter((file) => file.endsWith(".torrent"));

  torrentFiles.forEach((torrentFile) => {
    const infoHash = path.basename(torrentFile, ".torrent");
    const filePath = path.join(TORRENT_DIR, torrentFile);
    const metaPath = path.join(TORRENT_DIR, `${infoHash}.json`);

    const buffer = fs.readFileSync(filePath);

    let addedAt = Date.now(); // fallback time
    if (fs.existsSync(metaPath)) {
      try {
        const metadata = fs.readJsonSync(metaPath);
        if (typeof metadata.addedAt === "number") {
          addedAt = metadata.addedAt;
        }
      } catch (err) {
        log(`Failed to read metadata for ${infoHash}: ${err}`);
      }
    }

    try {
      streamClient.add(
        buffer,
        {
          path: DOWNLOAD_DIR,
          destroyStoreOnDestroy: false,
          // @ts-ignore
          deselect: true,
        },
        (torrent) => {
          log(`Restored seeding: ${torrent.name}`);

          const elapsed = Date.now() - addedAt;
          const remaining = SEED_TIME - elapsed;
          const readableAddedAt = new Date(addedAt).toLocaleString("hu-HU", { timeZone: "Europe/Budapest" });
          const readableExpiresAt = new Date(addedAt + SEED_TIME).toLocaleString("hu-HU", { timeZone: "Europe/Budapest" });
          
          dedupedLog(
           `seedcheck:${infoHash}`,
           `Seed check for ${torrent.name}:\n` +
             `addedAt: ${readableAddedAt}\n` +
             `expires: ${readableExpiresAt}`
           );

          if (remaining <= 0) {
            torrent.destroy(undefined, () => {
              log(`Seed time expired: ${torrent.name}`);
              fs.removeSync(filePath);
              fs.removeSync(metaPath);
              const downloadPath = path.join(DOWNLOAD_DIR, torrent.name);
              fs.remove(downloadPath).catch(() => {});
            });
          } else {
            const timeout = setTimeout(() => {
              torrent.destroy(undefined, () => {
                log(`Removed torrent after seed: ${torrent.name}`);
                fs.removeSync(filePath);
                fs.removeSync(metaPath);
                const downloadPath = path.join(DOWNLOAD_DIR, torrent.name);
                fs.remove(downloadPath).catch(() => {});
              });
            }, remaining);

            timeouts.set(infoHash, timeout);
          }
        }
      );
    } catch (e) {
      log(`Failed to restore ${torrentFile}: ${e}`);
    }
  });

  log(`Restored: ${torrentFiles.length} .torrent file(s) from disk.`);
};
//Application startup
restoreSavedTorrents();

setInterval(() => {
  streamClient.torrents.forEach((torrent) => {
    const infoHash = torrent.infoHash;
    const metaPath = path.join(TORRENT_DIR, `${infoHash}.json`);
    const filePath = path.join(TORRENT_DIR, `${infoHash}.torrent`);

    if (!fs.existsSync(metaPath)) return;

    try {
      const metadata = fs.readJsonSync(metaPath);
      if (typeof metadata.addedAt !== "number") return;

      const addedAt = metadata.addedAt;
      const elapsed = Date.now() - addedAt;

      if (elapsed >= SEED_TIME) {
        dedupedLog(
          `periodic-seed-expire:${infoHash}`,
          `Seed time expired: ${torrent.name}`
        );

        torrent.destroy(undefined, () => {
          fs.removeSync(filePath);
          fs.removeSync(metaPath);
          const downloadPath = path.join(DOWNLOAD_DIR, torrent.name);
          fs.remove(downloadPath).catch(() => {});
        });
      }
    } catch (e) {
      log(`Periodic seed check error for ${infoHash}: ${e}`);
    }
  });
}, 60 * 60 * 1000); // Check hourly
