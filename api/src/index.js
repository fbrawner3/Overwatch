const express = require('express');
const { getTopology } = require('./cache');
const { evaluateFromCache } = require('./evaluate');

const app = express();
const PORT = process.env.PORT || 3010;

app.get('/topology', async (req, res) => {
  try {
    const topo = await getTopology(req.query.force === '1');
    res.json(topo);
  } catch (err) {
    console.error('[hexmap-api] /topology error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Threshold watcher — called on a schedule (e.g. 60s heizou cron).
// Refreshes topology from shared cache when TTL expired; no HTTP call to /topology.
app.get('/evaluate', async (req, res) => {
  try {
    const result = await evaluateFromCache();
    res.json(result);
  } catch (err) {
    console.error('[hexmap-api] /evaluate error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`hexmap-api listening on :${PORT}`);
  getTopology().then(() => console.log('[hexmap-api] cache warmed')).catch(console.error);
});
