const express = require('express');
const { buildTopology } = require('./topology');

const app = express();
const PORT = process.env.PORT || 3010;
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || '60000');

let cache = null;
let cacheTime = 0;

app.get('/topology', async (req, res) => {
  try {
    const now = Date.now();
    const force = req.query.force === '1';
    if (force || !cache || now - cacheTime > CACHE_TTL) {
      cache = await buildTopology();
      cacheTime = now;
    }
    res.json(cache);
  } catch (err) {
    console.error('[hexmap-api] /topology error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, cacheAge: Date.now() - cacheTime }));

app.listen(PORT, () => {
  console.log(`hexmap-api listening on :${PORT}`);
  // Warm cache on startup
  buildTopology().then(t => { cache = t; cacheTime = Date.now(); }).catch(console.error);
});
