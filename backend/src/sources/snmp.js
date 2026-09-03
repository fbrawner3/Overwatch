const snmp = require('net-snmp');

// SNMP switch monitoring. The 3 managed switches have no REST API — SNMP v2c is
// the only way in. Each switch becomes one `type: 'switch'` node; the evaluator
// alerts on reachability (poll failed) and ports_down. Throughput / error rates
// are exposed in meta.snmp for the P2 frontend but are NOT alertable yet
// (error-rate thresholds need tuning against real baseline traffic).
//
// Config (env):
//   SNMP_COMMUNITY   shared v2c community string (required — unset => source skipped)
//   SNMP_TARGETS     optional JSON array to override the built-in switch list:
//                    [{"id":"trendnet-1","ip":"192.168.4.2","name":"TrendNet 1","uplink":"cyno"}]
//
// Rate fields (bpsIn/bpsOut/errPerMinIn/errPerMinOut) are null on the first poll
// after start and whenever a counter regresses (32-bit wrap on ifIn/OutErrors, or
// an agent reboot) — a regressed sample is dropped, not misreported as a spike.

const COMMUNITY = process.env.SNMP_COMMUNITY;

// id is the stable key (ticket idempotency, threshold_state rows) — do not
// change it. name is display only.
const DEFAULT_TARGETS = [
  { id: 'trendnet-1',  ip: '192.168.4.2', name: 'Closet Switch',   uplink: 'cyno' },
  { id: 'trendnet-2',  ip: '192.168.4.3', name: 'Office Switch-1', uplink: 'cyno' },
  { id: 'mokerlink-1', ip: '192.168.4.4', name: 'Office Switch-2', uplink: 'cyno' },
];

function loadTargets() {
  const raw = process.env.SNMP_TARGETS;
  if (!raw) return DEFAULT_TARGETS;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) throw new Error('not a non-empty array');
    return arr.filter(t => t && t.id && t.ip);
  } catch (err) {
    console.warn(`[snmp] SNMP_TARGETS ignored (${err.message}) — using built-in list`);
    return DEFAULT_TARGETS;
  }
}

// OIDs
const OID = {
  sysName:      '1.3.6.1.2.1.1.5.0',
  sysUpTime:    '1.3.6.1.2.1.1.3.0',
  ifType:       '1.3.6.1.2.1.2.2.1.3',
  ifAdminStatus:'1.3.6.1.2.1.2.2.1.7',
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
  ifInErrors:   '1.3.6.1.2.1.2.2.1.14',
  ifOutErrors:  '1.3.6.1.2.1.2.2.1.20',
  ifName:       '1.3.6.1.2.1.31.1.1.1.1',
  ifHCInOctets: '1.3.6.1.2.1.31.1.1.1.6',
  ifHCOutOctets:'1.3.6.1.2.1.31.1.1.1.10',
};

// IANAifType 6 = ethernetCsmacd (a real physical port). LAG aggregates (161),
// propVirtual (53), loopback (24), etc. are excluded — on these switches the
// LAG/trunk virtual interfaces sit admin-up / oper-down with no members and
// would otherwise be miscounted as downed ports.
const IF_TYPE_ETHERNET = 6;

const HARD_TIMEOUT_MS = 6000;   // whole-target ceiling, regardless of per-op retries

// Previous poll snapshot per target id, for rate math. { ts, in:{idx:BigInt}, out, ierr, oerr, uptime }
const prev = new Map();

function toBig(v) {
  if (v == null) return null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? BigInt(Math.trunc(v)) : null;
  if (Buffer.isBuffer(v)) return v.length ? BigInt('0x' + v.toString('hex')) : 0n;
  return null;
}

function leafIndex(fullOid, baseOid) {
  return fullOid.startsWith(baseOid + '.') ? fullOid.slice(baseOid.length + 1) : fullOid;
}

function getOids(session, oids) {
  return new Promise((resolve, reject) => {
    session.get(oids, (err, varbinds) => {
      if (err) return reject(err);
      const out = {};
      (varbinds || []).forEach((vb, i) => {
        out[oids[i]] = (vb && !snmp.isVarbindError(vb)) ? vb.value : null;
      });
      resolve(out);
    });
  });
}

function walk(session, baseOid) {
  return new Promise((resolve, reject) => {
    const out = {};
    session.subtree(
      baseOid, 20,
      (varbinds) => {
        for (const vb of varbinds || []) {
          if (!vb || snmp.isVarbindError(vb)) continue;
          out[leafIndex(vb.oid, baseOid)] = vb.value;
        }
      },
      (err) => (err ? reject(err) : resolve(out)),
    );
  });
}

async function pollTarget(t) {
  const session = snmp.createSession(t.ip, COMMUNITY, {
    version: snmp.Version2c,
    timeout: 2500,
    retries: 1,
    transport: 'udp4',
    port: 161,
  });

  const work = (async () => {
    const scalars = await getOids(session, [OID.sysName, OID.sysUpTime]);
    const sysName = scalars[OID.sysName] != null ? String(scalars[OID.sysName]) : null;
    // sysUpTime is TimeTicks (hundredths of a second)
    const uptimeTicks = Number(toBig(scalars[OID.sysUpTime]) ?? 0n);
    const uptimeSec = Math.round(uptimeTicks / 100);

    const [ifType, admin, oper, inOct, outOct, inErr, outErr, names] = await Promise.all([
      walk(session, OID.ifType),
      walk(session, OID.ifAdminStatus),
      walk(session, OID.ifOperStatus),
      walk(session, OID.ifHCInOctets),
      walk(session, OID.ifHCOutOctets),
      walk(session, OID.ifInErrors),
      walk(session, OID.ifOutErrors),
      walk(session, OID.ifName).catch(() => ({})),
    ]);

    // Physical ports only: ifType == ethernetCsmacd, with admin + oper status
    // present. Excludes LAG/trunk/loopback virtual interfaces.
    const portIdx = Object.keys(oper).filter(idx =>
      admin[idx] != null && Number(ifType[idx]) === IF_TYPE_ETHERNET
    );

    // A downed LINK — the only alertable port condition — is a port we have
    // observed oper-up and which has since gone oper-down and stayed down. It
    // clears the moment the port comes back up. An empty spare port is never
    // seen oper-up, so it never enters this set. First poll after a restart
    // starts from a clean slate (no prior observation => nothing counted).
    const p = prev.get(t.id);
    const nowTs = Date.now();
    const priorDownSince = (p && p.downSince) || {};
    const downSince = {};
    let portsAdminUp = 0, portsOperUp = 0;
    const downPorts = [];
    for (const idx of portIdx) {
      const isAdminUp = Number(admin[idx]) === 1;
      const isOperUp = Number(oper[idx]) === 1;
      const isOperDown = Number(oper[idx]) === 2;
      const wasOperUp = !!(p && p.operUp && p.operUp[idx]);
      if (isAdminUp) portsAdminUp++;
      if (isOperUp) portsOperUp++;
      if (isAdminUp && isOperDown && (wasOperUp || priorDownSince[idx])) {
        downSince[idx] = priorDownSince[idx] || nowTs;
        downPorts.push({
          ifIndex: Number(idx),
          name: names[idx] != null ? String(names[idx]) : `if${idx}`,
          downSince: new Date(downSince[idx]).toISOString(),
        });
      }
    }

    // Rate math against the previous snapshot for this target.
    const cur = { ts: nowTs, uptime: uptimeSec, in: {}, out: {}, ierr: {}, oerr: {}, operUp: {}, downSince };
    let sumIn = 0n, sumOut = 0n, sumIErr = 0n, sumOErr = 0n;
    for (const idx of portIdx) {
      cur.in[idx]   = toBig(inOct[idx])  ?? 0n;
      cur.out[idx]  = toBig(outOct[idx]) ?? 0n;
      cur.ierr[idx] = toBig(inErr[idx])  ?? 0n;
      cur.oerr[idx] = toBig(outErr[idx]) ?? 0n;
      cur.operUp[idx] = Number(oper[idx]) === 1;
      sumIn   += cur.in[idx];
      sumOut  += cur.out[idx];
      sumIErr += cur.ierr[idx];
      sumOErr += cur.oerr[idx];
    }

    let bpsIn = null, bpsOut = null, errPerMinIn = null, errPerMinOut = null;
    const uptimeReset = !!(p && uptimeSec < p.uptime);
    if (p && !uptimeReset) {
      const dtSec = (nowTs - p.ts) / 1000;
      if (dtSec >= 1) {
        let pIn = 0n, pOut = 0n, pIErr = 0n, pOErr = 0n;
        for (const idx of portIdx) {
          pIn   += p.in[idx]   ?? 0n;
          pOut  += p.out[idx]  ?? 0n;
          pIErr += p.ierr[idx] ?? 0n;
          pOErr += p.oerr[idx] ?? 0n;
        }
        // Drop the sample on any aggregate regression (wrap / reboot / port set change).
        if (sumIn >= pIn && sumOut >= pOut) {
          bpsIn  = Math.round(Number(sumIn  - pIn)  * 8 / dtSec);
          bpsOut = Math.round(Number(sumOut - pOut) * 8 / dtSec);
        }
        if (sumIErr >= pIErr && sumOErr >= pOErr) {
          errPerMinIn  = Math.round(Number(sumIErr - pIErr) / dtSec * 60 * 100) / 100;
          errPerMinOut = Math.round(Number(sumOErr - pOErr) / dtSec * 60 * 100) / 100;
        }
      }
    }
    prev.set(t.id, cur);

    return {
      pollOk: true,
      sysName,
      uptimeSec,
      uptimeReset,
      portsAdminUp,
      portsOperUp,
      portsLinkDown: downPorts.length,
      downPorts,
      bpsIn, bpsOut,
      errPerMinIn, errPerMinOut,
      polledAt: new Date().toISOString(),
    };
  })();

  let timer;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`poll exceeded ${HARD_TIMEOUT_MS}ms`)), HARD_TIMEOUT_MS);
  });

  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(timer);
    try { session.close(); } catch { /* already closed */ }
  }
}

function baseNode(t, status, snmpMeta) {
  return {
    id: t.id,
    name: t.name || snmpMeta.sysName || t.id,
    type: 'switch',
    layer: 'edge',
    isEdge: true,
    parentId: null,
    column: t.id,
    ip: t.ip,
    status,
    uplink: t.uplink || 'cyno',
    meta: { lokiLabel: t.id, snmp: snmpMeta },
  };
}

async function fetchSnmpNodes() {
  if (!COMMUNITY) { console.warn('[snmp] SNMP_COMMUNITY not set — skipping switch discovery'); return { nodes: [] }; }

  const targets = loadTargets();
  const results = await Promise.all(targets.map(async (t) => {
    try {
      const m = await pollTarget(t);
      console.log(`[snmp] ${t.id} up — ${m.portsOperUp}/${m.portsAdminUp} links up, ${m.portsLinkDown} link(s) down, uptime ${m.uptimeSec}s`);
      return baseNode(t, 'healthy', m);
    } catch (err) {
      console.warn(`[snmp] ${t.id} poll failed: ${err.message}`);
      return baseNode(t, 'critical', {
        pollOk: false,
        error: err.message,
        polledAt: new Date().toISOString(),
      });
    }
  }));

  return { nodes: results };
}

module.exports = { fetchSnmpNodes };
