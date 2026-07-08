const net = require('net');

// Returns true if TCP connect to host:port succeeds within timeout
function tcpCheck(host, port, timeoutMs = 5000) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, host);
  });
}

async function checkTcpStatus(hostname, port = 22) {
  const up = await tcpCheck(hostname, port);
  console.log(`[tcpcheck] ${hostname}:${port} → ${up ? 'up' : 'down'}`);
  return up ? 'healthy' : 'critical';
}

module.exports = { checkTcpStatus };
