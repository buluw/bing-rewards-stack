const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const history = [
  { ts: '2026-09-19T04:21:49Z', points: 588, gained: 105 },
  { ts: '2026-09-20T04:21:27Z', points: 873, gained: 105 },
];

test('today shows script gain 105 and separates the 180 earned between runs', async () => {
  const { bucketByDay, setTimeZone } = await import('../public/util.js');
  setTimeZone('Asia/Shanghai');
  const days = bucketByDay(history);
  assert.equal(days[1].gained, 105);
  assert.equal(days[1].otherChange, 180);
  assert.equal(days[1].lastTotal, 873);
});

test('multiple runs accumulate on the configured local day, without subtracting redemptions from script earnings', async () => {
  const { bucketByDay, setTimeZone } = await import('../public/util.js');
  setTimeZone('Asia/Shanghai');
  const rows = [...history, { ts: '2026-09-20T10:00:00Z', points: 823, gained: 50 },
    { ts: '2026-09-20T16:01:00Z', points: 826, gained: 3 }];
  const days = bucketByDay(rows.reverse());
  assert.equal(days[1].gained, 155);
  assert.equal(days[1].otherChange, 80);
  assert.equal(days[2].dayKey, '2026-09-21');
  assert.equal(days[2].gained, 3);
});

test('queried 973 supersedes old 873; subsequent run/live data wins by timestamp; null never erases a balance', async () => {
  const { accountBalance } = await import('../public/util.js');
  const account = { lastPoints: 873, lastEndAt: history[1].ts,
    balanceSnapshot: { balance: 973, checkedAt: '2026-09-20T06:00:00Z' } };
  assert.equal(accountBalance(account).balance, 973);
  assert.equal(accountBalance({ ...account, balanceSnapshot: { balance: null, checkedAt: '2026-09-20T07:00:00Z' } }).balance, 873);
  assert.equal(accountBalance({ ...account, lastPoints: 1078, lastEndAt: '2026-09-21T04:00:00Z' }).balance, 1078);
  assert.equal(accountBalance(account, { live: { balance: 976, lastUpdateTs: '2026-09-20T07:00:00Z' } }).balance, 976);
  assert.equal(accountBalance({ lastPoints: 0, lastEndAt: history[1].ts }).balance, 0);
});

test('saving a query preserves all script history, gains, status and schedule; failure retains the last snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-points-test-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  const { Store } = require('../lib/store');
  const store = new Store();
  try {
    store.db.prepare('INSERT INTO accounts(email,status,last_points,last_gained) VALUES(?,?,?,?)').run('a@test.invalid', 'success', 873, 105);
    store.db.prepare('INSERT INTO account_history(email,ts,points,gained) VALUES(?,?,?,?)').run('a@test.invalid', history[1].ts, 873, 105);
    store.setSchedule({ enabled: false, cron: '30 8 * * *' });
    const before = { accounts: store.snapshotAccounts(), history: store.allAccountHistories(), schedule: store.getSchedule() };
    const snapshot = { email: 'a@test.invalid', balance: 973, checkedAt: '2026-09-20T06:00:00Z' };
    store.setBalanceSnapshot(snapshot);
    assert.deepEqual(store.getBalanceSnapshot('A@test.invalid'), snapshot);
    assert.equal(store.getBalanceSnapshot('b@test.invalid'), null);
    assert.deepEqual({ accounts: store.snapshotAccounts(), history: store.allAccountHistories(), schedule: store.getSchedule() }, before);
    assert.throws(() => store.setBalanceSnapshot({ ...snapshot, balance: null }));
    assert.deepEqual(store.getBalanceSnapshot('a@test.invalid'), snapshot);
  } finally {
    store.close();
    if (previousDataDir == null) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parser classifies progress lines (READ-TO-EARN, SEARCH-BING) as progress kind', () => {
  const { parseLine } = require('../lib/parser');
  const dockerTs = '2026-09-22T02:00:00.000000000Z';
  const rawRead = dockerTs + ' [9/22/2026, 10:00:00 AM] [user] [INFO] MOBILE [READ-TO-EARN] Read article 1/10';
  const parsedRead = parseLine(rawRead);
  assert.equal(parsedRead.kind, 'progress');
  assert.equal(parsedRead.title, 'READ-TO-EARN');

  const rawSearch = dockerTs + ' [9/22/2026, 10:00:00 AM] [user] [INFO] DESKTOP [SEARCH-BING] Points gained=3';
  const parsedSearch = parseLine(rawSearch);
  assert.equal(parsedSearch.kind, 'progress');
  assert.equal(parsedSearch.title, 'SEARCH-BING');

  const rawGeneric = dockerTs + ' [9/22/2026, 10:00:00 AM] [user] [INFO] MAIN [OTHER] normal message';
  const parsedGeneric = parseLine(rawGeneric);
  assert.equal(parsedGeneric.kind, 'generic');
});

test('store ingests progress events into activity and updates lastActivity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-progress-test-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  const { Store } = require('../lib/store');
  const store = new Store();
  try {
    const ts = '2026-09-22T02:00:00.000Z';
    const progressEvent = {
      ts,
      level: 'info',
      title: 'READ-TO-EARN',
      kind: 'progress',
      userName: 'user',
      platform: 'MOBILE',
      email: 'a@test.invalid',
      message: 'Read article 1/10',
      raw: 'raw log line'
    };
    const changed = store.apply(progressEvent);
    assert.equal(changed, true);
    const lastActivity = store.stmts.lastActivitySince.get('2026-09-22T01:00:00.000Z');
    assert.equal(lastActivity.ts, ts);
  } finally {
    store.close();
    if (previousDataDir == null) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('store persists and retrieves bySource per account', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-bysource-test-'));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  const { Store } = require('../lib/store');
  const store = new Store();
  try {
    const sample = { search: 60, read: 90, checkIn: 50 };
    store.setBySource('user@test.invalid', sample);
    assert.deepEqual(store.getBySource('USER@TEST.INVALID'), sample);
    assert.equal(store.getBySource('unknown@test.invalid'), null);
  } finally {
    store.close();
    if (prev == null) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
