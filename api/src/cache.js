const { buildTopology } = require('./topology');

const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || '60000');
let _cache = null;
let _cacheTime = 0;

async function getTopology(force = false) {
  const now = Date.now();
  if (force || !_cache || now - _cacheTime > CACHE_TTL) {
    _cache = await buildTopology();
    _cacheTime = now;
  }
  return _cache;
}

module.exports = { getTopology };
