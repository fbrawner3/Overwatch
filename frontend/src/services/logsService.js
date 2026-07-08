const LOKI_URL = import.meta.env.VITE_LOKI_URL;

async function queryLogs(logql, start, end, limit) {
  const url = `${LOKI_URL}/loki/api/v1/query_range?query=${encodeURIComponent(logql)}&start=${start}&end=${end}&limit=${limit}&direction=backward`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.data?.result || []).flatMap(s => s.values.map(([ts, line]) => ({ ts, line })));
}

export async function getNodeLogs(lokiLabel, limit = 50) {
  if (!LOKI_URL || !lokiLabel) return [];
  const end = Date.now() * 1e6;
  const start = end - 3600 * 1e9;
  const primary = `{container="${lokiLabel}"}`;
  const logs = await queryLogs(primary, start, end, limit);
  if (logs.length > 0) return logs;
  const fallback = `{job=~".+"} |= \`${lokiLabel}\``;
  return queryLogs(fallback, start, end, limit);
}
