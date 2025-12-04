const recentLogs = new Map<string, number>();
const LOG_INTERVAL = 60 * 1000;

export const log = (...args: any[]) => {
  if (!args.length) return;

  const message = args
    .filter(x => x !== undefined && x !== null && String(x).trim() !== "")
    .join(" ");

  if (!message) return;

  const timezone = process.env.TZ || "Europe/Budapest";
  const now = new Date()
    .toLocaleString("sv-SE", { timeZone: timezone })
    .replace(",", "");

  console.log(`[${now}] ${message}`);
};

export function dedupedLog(key: string, ...args: any[]) {
  const now = Date.now();
  const lastLoggedAt = recentLogs.get(key) || 0;

  if (now - lastLoggedAt < LOG_INTERVAL) return;

  recentLogs.set(key, now);

  log(...args);
}