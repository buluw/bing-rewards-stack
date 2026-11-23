const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { Store } = require("../lib/store");
const { mergeAccounts } = require("../lib/accounts");
const { Scheduler } = require("../lib/scheduler");

function fixture(t) {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rewards-interrupted-"),
  );
  const store = new Store({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const status = {
    state: "idle",
    lastExit: {
      startedAt: "2026-10-25T01:00:00Z",
      at: "2026-10-25T01:04:22Z",
      code: 1,
    },
    run: {
      accounts: [
        {
          email: "a@test.invalid",
          success: null,
          live: {
            gained: 30,
            balance: 10779,
            lastUpdateTs: "2026-10-25T01:01:56Z",
          },
        },
      ],
    },
  };
  const roster = [
    { email: "a@test.invalid", index: 1 },
    { email: "b@test.invalid", index: 2 },
  ];
  return { store, status, roster };
}

test("manual controls also cancel a scheduled start still waiting for its roster", async (t) => {
  const { store } = fixture(t);
  let release;
  let posts = 0;
  const scheduler = new Scheduler({
    store,
    client: {
      get: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      post: async () => {
        posts++;
        return {};
      },
    },
  });
  t.after(() => scheduler.stop());
  scheduler.config.enabled = true;
  const firing = scheduler._fire();
  scheduler.cancelRecovery("manual stop");
  release({ accounts: [{ email: "a@test.invalid", index: 1 }] });
  await firing;
  assert.equal(posts, 0);
  assert.equal(store.getRecovery(), null);
});

test("an interrupted account never presents its old balance as newly observed", async (t) => {
  const { store, status } = fixture(t);
  const email = "a@test.invalid";
  store.db
    .prepare(
      "INSERT INTO accounts(email,status,last_points,last_end_at) VALUES(?,?,?,?)",
    )
    .run(email, "error", 10749, status.lastExit.at);
  store.db
    .prepare(
      "INSERT INTO account_history(email,ts,points,gained) VALUES(?,?,?,?)",
    )
    .run(email, "2026-10-24T01:54:12Z", 10749, 165);
  store.recordInterruptedAccounts(status);
  const account = mergeAccounts(
    [{ index: 1, email }],
    store.snapshotAccounts(),
    store.allAccountHistories(),
  )[0];
  account.partialSnapshot = store.getPartialSnapshot(email);
  const { accountBalance } = await import("../public/util.js");
  assert.equal(account.lastPointsAt, "2026-10-24T01:54:12Z");
  assert.equal(accountBalance(account).balance, 10779);
  account.partialSnapshot = null;
  account.balanceSnapshot = {
    balance: 10769,
    checkedAt: "2026-10-24T02:00:00Z",
  };
  assert.equal(accountBalance(account).balance, 10769);
});

test("confirmed gains without a balance are not later counted again as manual movement", async () => {
  const { bucketByDay, setTimeZone } = await import("../public/util.js");
  setTimeZone("Asia/Shanghai");
  const days = bucketByDay([
    { ts: "2026-10-24T01:00:00Z", points: 100, gained: 10 },
    { ts: "2026-10-25T01:00:00Z", points: null, gained: 30, status: "partial" },
    { ts: "2026-10-25T02:00:00Z", points: 150, gained: 20, status: "done" },
  ]);
  assert.equal(days[1].gained, 50);
  assert.equal(days[1].otherChange, 0);
});

test("crash preserves 30 confirmed points and an unknown not-started account without duplicate rows", (t) => {
  const { store, status, roster } = fixture(t);
  store.recordInterruptedAccounts(status);
  store.recordInterruptedAccounts(status, roster);
  store.recordInterruptedAccounts(status, roster);
  const histories = store.allAccountHistories();
  assert.equal(histories["a@test.invalid"].length, 1);
  assert.equal(histories["a@test.invalid"][0].gained, 30);
  assert.equal(histories["a@test.invalid"][0].points, 10779);
  assert.equal(histories["a@test.invalid"][0].status, "partial");
  assert.equal(histories["b@test.invalid"][0].gained, null);
  assert.equal(histories["b@test.invalid"][0].points, null);
  assert.equal(histories["b@test.invalid"][0].status, "not-started");
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM account_history").get().n,
    0,
  );
  assert.equal(store.getPartialSnapshot("A@test.invalid").balance, 10779);
});

test("reconciles a crash row already closed by the exit log, without claiming complete account balances", (t) => {
  const { store, status, roster } = fixture(t);
  store.db
    .prepare(
      "INSERT INTO runs(id,status,start_ts,end_ts,total_gained) VALUES(?, 'crashed', ?, ?, 0)",
    )
    .run("run", "2026-10-25T01:00:00.600Z", status.lastExit.at);
  store.recordInterruptedAccounts(status, roster);
  const run = store.snapshotRuns()[0];
  assert.equal(run.totalGained, 30);
  assert.equal(run.newTotal, null);
  assert.equal(run.oldTotal, null);
});

test("successful accounts never get a second partial history entry", (t) => {
  const { store, status, roster } = fixture(t);
  status.run.accounts[0].success = true;
  store.recordInterruptedAccounts(status, roster);
  assert.equal(store.allAccountHistories()["a@test.invalid"], undefined);
});

test("unknown partial gains stay unknown and genuine zero balances are preserved", (t) => {
  const { store, status } = fixture(t);
  status.run.accounts[0].live = { gained: 0, balance: 0, lastUpdateTs: null };
  store.recordInterruptedAccounts(status);
  assert.equal(store.accountHistory("a@test.invalid")[0].gained, null);
  assert.equal(store.getPartialSnapshot("a@test.invalid").balance, 0);
});

test("partial gain plus retry gain counts once each and keeps manual balance changes separate", async (t) => {
  const { store, status, roster } = fixture(t);
  store.db
    .prepare(
      "INSERT INTO account_history(email,ts,points,gained) VALUES(?,?,?,?)",
    )
    .run("a@test.invalid", "2026-10-24T01:54:12Z", 10749, 165);
  store.recordInterruptedAccounts(status, roster);
  store.db
    .prepare(
      "INSERT INTO account_history(email,ts,points,gained) VALUES(?,?,?,?)",
    )
    .run("a@test.invalid", "2026-10-25T03:00:00Z", 11059, 100);
  const { bucketByDay, setTimeZone, accountBalance } =
    await import("../public/util.js");
  const { buildAccumBarHtml, buildHeatmapHtml } =
    await import("../public/charts.js");
  setTimeZone("Asia/Shanghai");
  const days = bucketByDay(store.accountHistory("a@test.invalid"));
  assert.equal(days[1].gained, 130);
  assert.equal(days[1].otherChange, 180);
  assert.equal(days[1].status, "recovered");
  assert.equal(
    accountBalance({
      partialSnapshot: store.getPartialSnapshot("a@test.invalid"),
    }).balance,
    10779,
  );
  const unknown = bucketByDay(store.accountHistory("b@test.invalid"));
  assert.equal(unknown[0].hasConfirmedGain, false);
  assert.equal(unknown[0].lastTotal, null);
  const html = buildAccumBarHtml(unknown, 1);
  // Use a current fixture date for the rolling accumulation window.
  const current = {
    ...unknown[0],
    dayKey: new Date().toISOString().slice(0, 10),
  };
  const currentHtml = buildAccumBarHtml([current], 1);
  assert.match(currentHtml, /未开始/);
  assert.match(currentHtml, /积分未知/);
  assert.match(currentHtml, /accum-day--partial/);
  assert.doesNotThrow(() => buildHeatmapHtml([current]));
  assert.equal(typeof html, "string");
});

test("read-only balance snapshots cannot change partial or completed script history", (t) => {
  const { store, status } = fixture(t);
  store.recordInterruptedAccounts(status);
  const before = store.allAccountHistories();
  store.setBalanceSnapshot({
    email: "a@test.invalid",
    balance: 10959,
    checkedAt: "2026-10-25T02:00:00Z",
  });
  assert.deepEqual(store.allAccountHistories(), before);
});

test("partial status received before process exit closes the run with confirmed gains, never an invented total balance", (t) => {
  const { store, status, roster } = fixture(t);
  store.db
    .prepare("INSERT INTO runs(id,status,start_ts) VALUES(?, 'running', ?)")
    .run("run", "2026-10-25T01:00:00.600Z");
  store.recordInterruptedAccounts(status, roster);
  assert.equal(store.closeRunOnExit(status.lastExit), true);
  const run = store.snapshotRuns()[0];
  assert.equal(run.totalGained, 30);
  assert.equal(run.newTotal, null);
  assert.equal(run.status, "crashed");
});

test("completely unknown interrupted earnings remain NULL in the run summary", (t) => {
  const { store, status, roster } = fixture(t);
  status.run.accounts = [];
  store.db
    .prepare("INSERT INTO runs(id,status,start_ts) VALUES(?, 'running', ?)")
    .run("run", "2026-10-25T01:00:00.600Z");
  store.recordInterruptedAccounts(status, roster);
  store.closeRunOnExit(status.lastExit);
  assert.equal(store.snapshotRuns()[0].totalGained, null);
  assert.equal(store.snapshotRuns()[0].newTotal, null);
});

test("a stale exit cannot close a newer run", (t) => {
  const { store, status } = fixture(t);
  store.db
    .prepare("INSERT INTO runs(id,status,start_ts) VALUES(?, 'running', ?)")
    .run("new", "2026-10-25T02:00:00.600Z");
  assert.equal(store.closeRunOnExit(status.lastExit), false);
  assert.equal(store.snapshotRuns()[0].status, "running");
});

test("an authoritative account result arriving after partial status replaces that same run in history", (t) => {
  const { store, status } = fixture(t);
  store.recordInterruptedAccounts(status);
  store.apply({
    kind: "account-end",
    title: "ACCOUNT-END",
    email: "a@test.invalid",
    ts: "2026-10-25T01:04:21.000Z",
    gained: 40,
    newPoints: 10789,
    durationSec: 260,
  });
  const history = store.accountHistory("a@test.invalid");
  assert.equal(history.length, 1);
  assert.equal(history[0].gained, 40);
  assert.equal(history[0].status, "done");
  assert.equal(store.getPartialSnapshot("a@test.invalid"), null);
});

test("opening an existing database preserves its completed history and schedule", (t) => {
  const { DatabaseSync } = require("node:sqlite");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rewards-migrate-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dataDir, "dashboard.sqlite"));
  db.exec(`CREATE TABLE account_history(id INTEGER PRIMARY KEY, email TEXT NOT NULL, ts TEXT NOT NULL, points INTEGER NOT NULL, gained INTEGER NOT NULL, duration_sec REAL) STRICT;
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT) STRICT;`);
  db.prepare(
    "INSERT INTO account_history(email,ts,points,gained) VALUES(?,?,?,?)",
  ).run("a@test.invalid", "2026-10-24T01:54:12Z", 10749, 165);
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(
    "schedule",
    JSON.stringify({ enabled: true, cron: "0 9 * * *" }),
  );
  db.close();
  const store = new Store({ dataDir });
  try {
    assert.equal(store.accountHistory("a@test.invalid")[0].points, 10749);
    assert.equal(store.accountHistory("a@test.invalid")[0].gained, 165);
    assert.equal(store.getSchedule().cron, "0 9 * * *");
    assert.throws(() =>
      store.db
        .prepare(
          "INSERT INTO account_history(email,ts,points,gained) VALUES(?,?,?,?)",
        )
        .run("a@test.invalid", "2026-10-25T01:54:12Z", null, null),
    );
  } finally {
    store.close();
  }
});

test("scheduled start, crash history and recovery use the same process identity and exclude the completed account", async (t) => {
  const { store } = fixture(t);
  let clock = Date.now();
  const scheduledAt = new Date(clock).toISOString();
  const calls = [];
  const roster = {
    accounts: [1, 2, 3].map((index) => ({
      index,
      email: `${String.fromCharCode(96 + index)}@test.invalid`,
    })),
  };
  let status;
  const client = {
    async get(path) {
      return path === "/accounts" ? roster : status;
    },
    async post(path, body) {
      calls.push({ path, body });
      return { started: true, startedAt: new Date(clock).toISOString() };
    },
  };
  const scheduler = new Scheduler({ client, store });
  t.after(() => scheduler.stop());
  scheduler.config.enabled = true;
  scheduler.recovery.now = () => clock;
  await scheduler._fire({ scheduledAt });
  assert.equal(calls.length, 1);
  assert.equal(store.getRecovery().runStartedAt, scheduledAt);
  const runStart = new Date(clock + 1).toISOString();
  store.apply({
    kind: "run-start",
    title: "RUN-START",
    ts: runStart,
    version: "test",
    totalAccounts: 3,
    clusters: 1,
  });
  store.apply({
    kind: "account-end",
    title: "ACCOUNT-END",
    ts: new Date(clock + 2).toISOString(),
    email: "a@test.invalid",
    gained: 10,
    newPoints: 110,
    durationSec: 1,
  });
  clock += 10_000;
  status = {
    state: "idle",
    lastExit: {
      startedAt: scheduledAt,
      at: new Date(clock).toISOString(),
      code: 1,
    },
    run: {
      accounts: [
        { email: "a@test.invalid", success: true },
        {
          email: "b@test.invalid",
          success: null,
          live: {
            balance: 230,
            gained: 30,
            lastUpdateTs: new Date(clock - 1).toISOString(),
          },
        },
      ],
    },
  };
  store.recordInterruptedAccounts(status);
  store.closeRunOnExit(status.lastExit);
  await scheduler.recovery.observe(status);
  assert.equal(store.getRecovery().phase, "waiting");
  assert.equal(store.accountHistory("b@test.invalid")[0].gained, 30);
  assert.equal(store.accountHistory("c@test.invalid")[0].status, "not-started");
  assert.equal(store.snapshotRuns()[0].totalGained, 40);
  clock += 120_000;
  await scheduler.recovery.observe(status);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { excludedAccountIndexes: [1] });
  assert.equal(store.getRecovery().retries, 1);
});
