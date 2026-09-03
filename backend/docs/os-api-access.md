# OS-Level API Access for Hexmap Discovery

## Goal

Give hexmap-api live access to OS stats (CPU, memory, disk, uptime, IP) from:
- Debian/Ubuntu bare-metal servers (heizou, noelle)
- Synology NAS (zhongli) — already handled via Docker TCP
- AWS Lightsail (kazuha)
- Home Assistant (if applicable)

---

## Option A: Netdata (Recommended)

One-liner install, zero config, REST API with token auth. Works on Debian, Ubuntu, Alpine, and AWS Linux.

### Install on each Linux host

```bash
curl https://get.netdata.cloud/kickstart.sh > /tmp/netdata-kickstart.sh
sh /tmp/netdata-kickstart.sh --no-updates --stable-channel
```

Starts automatically on port **19999**.

### Lock down the API (required)

Edit `/etc/netdata/netdata.conf`:

```ini
[web]
    allow connections from = 10.0.0.0/24 10.0.0.0/8
    allow dashboard from = 10.0.0.0/24
    allow netdata.conf from = localhost
```

Generate an API key (Netdata v2.0+):

```bash
uuidgen  # copy this — it's your token
```

Edit `/etc/netdata/netdata.conf`:

```ini
[web]
    enable gzip compression = yes
    # Netdata v2 token auth is via bearer — set in stream.conf or via cloud claim
```

**Simpler approach** — restrict by IP and put it behind nginx with basic auth or bearer token proxy:

```nginx
location /netdata/ {
    proxy_pass http://127.0.0.1:19999/;
    auth_request /auth;
}
```

Or just restrict to the hexmap-api server IP in `netdata.conf` and skip auth (LAN-only, Proxmox-equivalent security).

### Verify it works

```bash
curl http://heizou:19999/api/v1/info
```

Returns: hostname, OS, uptime, CPU count, etc.

```bash
curl http://heizou:19999/api/v1/data?chart=system.cpu&points=1&after=-1
```

Returns live CPU percent.

---

## Option B: Glances (lighter, REST API)

```bash
pip3 install glances
glances -w --password  # prompts for password, runs on :61208
```

API: `GET http://heizou:61208/api/3/all`

Returns everything including network interfaces with IPs.

```bash
# As a systemd service
cat > /etc/systemd/system/glances.service << EOF
[Unit]
Description=Glances
After=network.target

[Service]
ExecStart=/usr/bin/glances -w
Restart=always

[Install]
WantedBy=multi-user.target
EOF
systemctl enable --now glances
```

---

## Kazuha (AWS Lightsail)

Kazuha is AWS Linux (not in the LAN). Two options:

**Option 1 — Tunnel via Pangolin (already exists)**
Expose Netdata through the existing Pangolin/Newt tunnel. hexmap-api reaches it as if it's local.

**Option 2 — Secure direct access**
Lightsail firewall: open port 19999 to your WAN IP only. Then hexmap-api calls `http://kazuha-lightsail-ip:19999/api/v1/info`.

Set `KAZUHA_IP` or `KAZUHA_NETDATA_URL` in hexmap-api `.env.local`.

---

## DNS Resolution (replaces hardcoded IPs)

The non-proxmox-nodes code already does `dns.lookup(hostname)`. For this to work:

- `heizou`, `zhongli`, `noelle`, `kazuha` must be resolvable from the hexmap-api server
- Add them to OPNsense Unbound (or `/etc/hosts` on heizou where hexmap-api runs)

OPNsense → Services → Unbound DNS → Host Overrides:

| Host     | Domain | IP             |
|----------|--------|----------------|
| heizou   | local  | 10.0.0.20   |
| zhongli  | local  | 10.0.0.10   |
| noelle   | local  | 10.0.0.15   |
| cyno     | local  | 10.0.1.1    |

If hostnames resolve, IPs are discovered live — no `.env` config needed.

---

## hexmap-api Integration

Once Netdata is up, add a `sources/netdata.js` to enrich non-Proxmox nodes with live stats:

```javascript
async function fetchNetdataInfo(hostname) {
  const url = process.env[`${hostname.toUpperCase()}_NETDATA_URL`] || `http://${hostname}:19999`;
  try {
    const res = await fetch(`${url}/api/v1/info`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    // data.ip has the detected IP from Netdata's perspective
    // data.os_name, data.kernel_version, etc.
    return { ip: data.ip, uptime: data.uptime, os: data.os_name };
  } catch {
    return null;
  }
}
```

This gives live IP from the Netdata API — the actual IP the server sees on its interface, not a hardcoded value.

---

## Home Assistant

HA has a built-in REST API. Generate a Long-Lived Access Token:

Profile → Long-Lived Access Tokens → Create

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
     http://heizou:8123/api/states/sensor.processor_use_percent
```

Set in `.env.local`:
```
HA_URL=http://heizou:8123
HA_TOKEN=your-long-lived-token
```

Then hexmap-api can pull entity states directly for any HA-connected device.
