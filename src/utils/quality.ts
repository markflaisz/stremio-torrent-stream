const clamp = (num: number, min: number, max: number) =>
  Math.min(Math.max(num, min), max);

export interface QualityGuess {
  quality: string;
  score: number;
  resolution: string | null;
  isCamOrTs: boolean;
}

export interface TorrentRatingInput {
  name: string;

  seeds?: number;
  peers?: number;

  sizeBytes?: number;
  source?: string;

  hasHunAudio?: boolean;
  hasHunSub?: boolean;

  isSeasonPack?: boolean;
  isFreeleech?: boolean;

  isEpisode?: boolean;
}

export const guessQuality = (name: string): QualityGuess => {
  const split = name.replace(/\W/g, " ").toLowerCase().split(" ");

  let score = 0;
  const parts: string[] = [];

  let resolution: string | null = null;
  let isCamOrTs = false;

  if (split.includes("2160p")) {
    parts.push("4K");
    score += 3000;
    resolution = "2160p";
  } else if (split.includes("1080p")) {
    parts.push("1080p");
    score += 2000;
    resolution = "1080p";
  } else if (split.includes("720p")) {
    parts.push("720p");
    score += 1000;
    resolution = "720p";
  } else if (split.includes("480p")) {
    parts.push("480p");
    score += 500;
    resolution = "480p";
  }

  if (
    (split.includes("dolby") && split.includes("vision")) ||
    split.includes("dovi") ||
    split.includes("dv") ||
    split.includes("hdr")
  ) {
    parts.push("HDR");
    score += 10;
  }

  if (
    split.includes("bluray") ||
    (split.includes("blu") && split.includes("ray")) ||
    split.includes("bdrip") ||
    split.includes("brrip")
  ) {
    parts.push("BluRay");
    score += 500;

    if (split.includes("remux")) {
      parts.push("Remux");
      score += 100;
    }
  } else if (split.includes("webrip") || split.includes("webdl") || split.includes("web")) {
    parts.push("WEB");
    score += 400;
  } else if (split.includes("dvdrip")) {
    parts.push("DVD");
    score += 300;
  } else if (split.includes("hdtv")) {
    parts.push("HDTV");
    score += 200;
  } else if (split.includes("sdtv")) {
    parts.push("SDTV");
    score += 100;
  } else if (
    split.includes("camrip") ||
    split.includes("cam") ||
    split.includes("hdcam") ||
    split.includes("ts") ||
    split.includes("hdts") ||
    split.includes("tc") ||
    split.includes("hdtc")
  ) {
    parts.push("CAM");
    score -= 5000;
    isCamOrTs = true;
  }

  if (split.includes("3d")) {
    parts.push("3D");
    score -= 1;
  }

  if (parts.length === 0) {
    parts.push("Unknown");
    score = -Infinity;
  }

  return {
    quality: parts.join(" "),
    score,
    resolution,
    isCamOrTs,
  };
};

function computeSeedScore(seeds: number): number {
  const cap = 100;
  const s = Math.min(seeds, cap);
  return clamp(Math.log10(s + 1) / Math.log10(cap + 1), 0, 1);
}

function computeResolutionScore(resolution: string | null): number {
  switch ((resolution || "").toLowerCase()) {
    case "2160p":
      return 1.0;
    case "1440p":
      return 0.95;
    case "1080p":
      return 0.9;
    case "720p":
      return 0.75;
    case "480p":
      return 0.55;
    default:
      return 0.3;
  }
}

function computeSizeScore(sizeBytes?: number, isEpisode?: boolean): number {
  if (!sizeBytes) return 0;

  const sizeGB = sizeBytes / 1024 ** 3;

  if (isEpisode) {
    if (sizeGB < 0.3 || sizeGB > 12) return 0;

    const idealMin = 1.2;
    const idealMax = 7.0;
    const center = (idealMin + idealMax) / 2;
    const dist = Math.abs(sizeGB - center);
    return clamp(1 - dist / center, 0, 1);
  }

  if (sizeGB < 0.7 || sizeGB > 60) return 0;

  const idealMin = 4.0;
  const idealMax = 16.0;
  const center = (idealMin + idealMax) / 2;
  const dist = Math.abs(sizeGB - center);

  return clamp(1 - dist / center, -1, 1);
}

function computeSourceScore(source?: string): number {
  switch ((source || "").toLowerCase()) {
    case "ncore":
      return 1.0;
    case "yts":
      return 0.8;
    case "eztv":
    case "jackett":
      return 0.7;
    default:
      return 0.5;
  }
}

function isWebName(nameLower: string): boolean {
  return (
    nameLower.includes("webrip") ||
    nameLower.includes("webdl") ||
    /\bweb\b/.test(nameLower)
  );
}

function isRemuxName(nameLower: string): boolean {
  return /\bremux\b/.test(nameLower);
}

export function rateTorrent(meta: TorrentRatingInput): number {
  const q = guessQuality(meta.name);
  const nameLower = meta.name.toLowerCase();

  const seeds = meta.seeds ?? 0;

  const seedScore = computeSeedScore(seeds);
  const resolutionScore = computeResolutionScore(q.resolution);
  const sizeScore = computeSizeScore(meta.sizeBytes, meta.isEpisode);
  const sourceScore = computeSourceScore(meta.source);

  const hunScore =
    (meta.hasHunAudio ? 1 : 0) * 0.7 + (meta.hasHunSub ? 1 : 0) * 0.3;

  const packScore = meta.isSeasonPack ? 1 : 0;
  const freeleechScore = meta.isFreeleech ? 1 : 0;

  let penalties = 0;

  if (q.isCamOrTs) penalties -= 0.9;
  if (seeds === 0) penalties -= 1.0;

  if (meta.sizeBytes) {
    const sizeGB = meta.sizeBytes / 1024 ** 3;

    if (meta.isEpisode) {
      if (sizeGB > 15) penalties -= 3.0;
      else if (sizeGB > 10) penalties -= 1.5;

      if (sizeGB < 1.2) penalties -= 1.0;
      else if (sizeGB < 2.0) penalties -= 0.4;
    } else {
      const isWeb = isWebName(nameLower);
      const isRemux = isRemuxName(nameLower);

      if (isWeb && sizeGB > 20) penalties -= 0.35;
      else if (isWeb && sizeGB > 16) penalties -= 0.18;

      if (isRemux && sizeGB > 30) penalties -= 0.6;
      if (!isRemux && sizeGB > 45) penalties -= 0.35;
    }

    if (sizeGB < 0.7) penalties -= 0.4;
    if (sizeGB > 80) penalties -= 0.5;
  }

  const wSeeds = 0.12;
  const wRes = 0.28;
  const wSize = 0.30;
  const wSource = 0.10;
  const wHun = 0.15;
  const wPack = 0.05;
  const wFreeleech = 0.05;

  return (
    wSeeds * seedScore +
    wRes * resolutionScore +
    wSize * sizeScore +
    wSource * sourceScore +
    wHun * hunScore +
    wPack * packScore +
    wFreeleech * freeleechScore +
    penalties
  );
}