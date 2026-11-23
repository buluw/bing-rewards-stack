// Local UI fixture: never connects to Docker2 or Microsoft and has no real credentials.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-preview-'));
process.env.DATA_DIR = dir;
const { Store } = require('../lib/store');
const store = new Store();
const emails = ['account1@example.invalid', 'account2@example.invalid'];
for (const [index, email] of emails.entries()) {
  store.db.prepare('INSERT INTO accounts(email,status,last_points,last_gained,last_end_at,last_duration_sec) VALUES(?,?,?,?,?,?)')
    .run(email, 'success', index ? 715 : 873, 105, '2026-09-20T07:32:37Z', 12087);
  for (const [day, points] of [[19, index ? 610 : 588], [20, index ? 715 : 873]]) {
    store.db.prepare('INSERT INTO account_history(email,ts,points,gained,duration_sec) VALUES(?,?,?,?,?)')
      .run(email, `2026-09-${day}T04:21:27Z`, points, 105, 12087);
  }
}
store.setSchedule({ enabled: false, cron: '30 8 * * *', timezone: 'Asia/Shanghai' });
store.close();
const status = { state: 'idle', run: { accountsTotal: 2, collected: 210, finished: true,
  accounts: emails.map(email => ({ email, success: true, collectedPoints: 105 })) } };
const clients = new Set();
const calls = [];
const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const routes = {
    '/health': { ok: true, state: 'idle', name: 'local-preview', version: '4.3.2.3-local', uptimeSec: 10000 },
    '/status': status,
    '/accounts': { accounts: emails.map((email, i) => ({ index: i + 1, email, successStreak: 3 })) },
    '/logs': { logs: [] },
    '/schedule': { enabled: false },
  };
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`event: hello\ndata: ${JSON.stringify(status)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/balance') {
    calls.push({ method: req.method, path: url.pathname });
    const index = Number(url.searchParams.get('accountIndex'));
    routes['/balance'] = { email: emails[index - 1], accountIndex: index, balance: index === 1 ? 973 : 715, checkedAt: new Date().toISOString() };
  }
  if (url.pathname === '/test-requests') routes['/test-requests'] = calls;
  res.writeHead(req.method === 'GET' && url.pathname in routes ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(routes[url.pathname] || { error: 'Fixture has no task execution endpoints' }));
});
let child;
mock.listen(0, '127.0.0.1', () => {
  const apiPort = mock.address().port;
  const port = process.env.PREVIEW_PORT || '18890';
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true,
    env: { ...process.env, PORT: port, CONTROL_API_URL: `http://127.0.0.1:${apiPort}`, CONTROL_API_TOKEN: '', DASHBOARD_USERNAME: '', DASHBOARD_PASSWORD: '', TZ: 'Asia/Shanghai' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  console.log(`PREVIEW=http://127.0.0.1:${port} MOCK=http://127.0.0.1:${apiPort}`);
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const response of clients) response.end();
  mock.close();
  const cleanup = () => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); };
  if (child) { child.once('exit', cleanup); child.kill(); }
  else cleanup();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.stdin.on('data', stop);
