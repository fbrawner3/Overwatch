const net = require('net');

const DB_PORTS = [
  { port: 27017, type: 'mongodb' },
  { port: 5432,  type: 'postgres' },
  { port: 3306,  type: 'mariadb' },
];

// Key name substrings that indicate which DB type an app uses
const DB_KEY_PATTERNS = [
  { pattern: /MONGO/i,              type: 'mongodb' },
  { pattern: /POSTGRES|PGSQL|^PG_/i, type: 'postgres' },
  { pattern: /MYSQL|MARIADB|MARIA/i, type: 'mariadb' },
];

function tcpProbe(host, port, timeoutMs = 2000) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = result => { if (!done) { done = true; sock.destroy(); resolve(result); } };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('error',   () => finish(false));
    sock.on('timeout', () => finish(false));
    sock.connect(port, host);
  });
}

async function buildDbPortMap(lxcNodes) {
  const map = {}; // dbType → nodeId
  const probes = [];
  for (const node of lxcNodes) {
    if (!node.ip) continue;
    for (const { port, type } of DB_PORTS) {
      probes.push(
        tcpProbe(node.ip, port).then(open => {
          if (open && !map[type]) {
            map[type] = node.id;
            console.log(`[dbprobe] ${node.id} (${node.ip}:${port}) → ${type}`);
          }
        })
      );
    }
  }
  await Promise.all(probes);
  console.log(`[dbprobe] map: ${JSON.stringify(map)}`);
  return map;
}

function dbTypesFromEnvKeys(envKeys) {
  const types = new Set();
  for (const key of envKeys) {
    for (const { pattern, type } of DB_KEY_PATTERNS) {
      if (pattern.test(key)) types.add(type);
    }
  }
  return types;
}

module.exports = { buildDbPortMap, dbTypesFromEnvKeys };
