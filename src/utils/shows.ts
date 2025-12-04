export function matchEpisodePatterns(
  name: string,
  season: number,
  episode: number
): boolean {
  const lower = name.toLowerCase();

  const s = season;
  const e = episode;
  const sPad = season.toString().padStart(2, "0");
  const ePad = episode.toString().padStart(2, "0");

  const patterns: RegExp[] = [

    new RegExp(`s0?${s}[^a-z0-9]?e0?${e}(?!\\d)`, "i"),

    new RegExp(`${s}[^a-z0-9]?x0?${e}(?!\\d)`, "i"),

    new RegExp(
      `${s}\\s*\\.\\s*${e}\\s*\\.\\s*(resz|rész)`,
      "i"
    ),
    new RegExp(
      `${s}\\s*(evad|évad)[^0-9]*0?${e}\\s*(resz|rész)`,
      "i"
    ),
    new RegExp(
      `${s}\\s*(evad|évad)[^0-9]*${e}\\s*(resz|rész)`,
      "i"
    ),

    new RegExp(`\\b${sPad}${ePad}\\b`, "i"),
  ];

  return patterns.some((re) => re.test(lower));
}
