export async function getTmdbTitleFromWeb(tmdbId: string): Promise<string | null> {
  try {
    const url = `https://www.themoviedb.org/tv/${tmdbId}`;

    const res = await fetch(url);
    if (!res.ok) {
      console.warn("[TMDB-WEB] Bad status", res.status);
      return null;
    }

    const html = await res.text();

    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      return titleMatch[1].trim();
    }

    const h2Match = html.match(/<h2.*?>(.*?)<\/h2>/i);
    if (h2Match && h2Match[1]) {
      return h2Match[1].trim();
    }

    return null;

  } catch (e) {
    console.warn("[TMDB-WEB] Error:", e);
    return null;
  }
}

export function normalizeTmdbTitle(raw: string): string {
  if (!raw) return "";

  let title = raw;

  if (title.includes("—")) {
    title = title.split("—")[0].trim();
  }

  if (title.includes("(")) {
    title = title.split("(")[0].trim();
  }

  title = title.replace(/The Movie Database/i, "").trim();
  title = title.replace(/\s\s+/g, " ");

  return title.trim();
}
