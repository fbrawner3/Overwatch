#!/usr/bin/env python3
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import json, time, os

SECRET = os.environ.get('STATS_TOKEN', '')

def cpu_percent():
    def read():
        with open('/proc/stat') as f:
            fields = f.readline().split()
        idle = int(fields[4])
        total = sum(int(x) for x in fields[1:])
        return idle, total
    i1, t1 = read()
    time.sleep(0.5)
    i2, t2 = read()
    dt = t2 - t1
    return round((1 - (i2 - i1) / dt) * 100, 1) if dt else 0.0

def mem_percent():
    vals = {}
    with open('/proc/meminfo') as f:
        for line in f:
            k, v = line.split(':')
            vals[k.strip()] = int(v.split()[0])
    total = vals.get('MemTotal', 0)
    avail = vals.get('MemAvailable', 0)
    return round((total - avail) / total * 100, 1) if total else 0.0

def disk_percent(path='/'):
    st = os.statvfs(path)
    total = st.f_blocks * st.f_frsize
    used = total - st.f_bfree * st.f_frsize
    return round(used / total * 100, 1) if total else 0.0

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/stats':
            self.send_response(404); self.end_headers(); return
        if SECRET:
            auth = self.headers.get('Authorization', '')
            if auth != f'Bearer {SECRET}':
                self.send_response(401); self.end_headers(); return
        data = json.dumps({
            'cpuPercent': cpu_percent(),
            'memPercent': mem_percent(),
            'diskPercent': disk_percent('/'),
            'status': 'healthy',
        }).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(data))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *args): pass

if __name__ == '__main__':
    print('kazuha-stats listening on :9101')
    ThreadingHTTPServer(('0.0.0.0', 9101), Handler).serve_forever()
