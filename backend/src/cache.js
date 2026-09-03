const { buildTopology } = require('./topology');

const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || '60000');

let _cache = null;
let _cacheTime = 0;
let _inflight = null;
let _generation = 0;
let _lastBuildError = null;

// Single-flight: concurrent callers after a cache miss share one buildTopology()
// run. If bustCache() bumps the generation while a build is in flight, that
// build's result is discarded (it predates the change) and a fresh build runs.
// If a build throws and a previous good result exists, that stale result is
// served (flagged `stale: true`) rather than propagating the failure — a total
// discovery outage must not turn /evaluate into a 500 and blind alerting.
async function getTopology(force = false) {
  const now = Date.now();
  if (!force && _cache && now - _cacheTime <= CACHE_TTL) return _cache;
  if (_inflight) return _inflight;

  const gen = _generation;
  _inflight = buildTopology()
    .then(result => {
      _inflight = null;
      _lastBuildError = null;
      if (gen !== _generation) return getTopology(true); // busted mid-build — rebuild
      _cache = result;
      _cacheTime = Date.now();
      return result;
    })
    .catch(err => {
      _inflight = null;
      _lastBuildError = err;
      if (_cache) {
        console.error('[cache] buildTopology failed — serving stale topology:', err.message);
        return { ..._cache, stale: true, staleReason: err.message, staleSince: new Date(_cacheTime).toISOString() };
      }
      throw err; // cold start with no prior good build — nothing to serve
    });
  return _inflight;
}

// Invalidate the cached topology. Bumps the generation so any in-flight build
// is treated as stale on completion.
function bustCache() {
  _cache = null;
  _cacheTime = 0;
  _generation++;
}

// Patch a single node's maintenance flag in the cached topology in place, so a
// maintenance toggle doesn't force a full 10-source rediscovery. No-op if the
// cache is cold or the node isn't present (a real rebuild will pick it up from
// the DB). `info` is the maintenance row, or null to clear.
function patchMaintenance(nodeId, info) {
  if (!_cache || !Array.isArray(_cache.nodes)) return false;
  const node = _cache.nodes.find(n => n.id === nodeId);
  if (!node) return false;
  node.meta = { ...node.meta, maintenance: !!info };
  if (info) node.meta.maintenanceInfo = info;
  else delete node.meta.maintenanceInfo;
  return true;
}

module.exports = { getTopology, bustCache, patchMaintenance };
