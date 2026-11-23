const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { Store } = require("../lib/store");
const { parseLine } = require("../lib/parser");
const { mergeAccounts } = require("../lib/accounts");

const first = "First@Test.invalid";
const second = "second@test.invalid";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rewards-results-"));
  const store = new Store({ dataDir: dir });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let clock = Date.parse("2026-11-03T01:00:00.000Z");
  const event = (title, message, level = "INFO") => {
    clock += 10;
    return parseLine(
      `${new Date(clock).toISOString()} [11/3/2026, 9:00:00 AM] [fixture] [${level}] MAIN [${title}] ${message}`,
    );
  };
  const ingest = (title, message, level) => {
    const parsed = event(title, message, level);
    store.apply(parsed);
    return parsed;
  };
  return { store, ingest, event };
}

test("a partial account remains failed, appears in mixed-case history and contributes its gain once beside a successful account", async (t) => {
  const { store, ingest } = fixture(t);
  store.db
    .prepare(
      "INSERT INTO accounts(email,status,last_points,last_gained,last_duration_sec,last_end_at) VALUES(?,?,?,?,?,?)",
    )
    .run(first, "success", 12816, 781, 3747.8, "2026-11-02T02:02:28Z");
  store.db
    .prepare(
      "INSERT INTO account_history(email,ts,points,gained) VALUES(?,?,?,?)",
    )
    .run(first, "2026-11-02T02:02:28Z", 12816, 781);
  ingest("RUN-START", "启动微软奖励脚本 | v4.3.2.4 | 账户数: 2 | 集群数: 1");
  ingest(
    "ACCOUNT-START",
    `开始处理账户: ${first} | geoLocale: CN | locale: zh-CN`,
  );
  ingest(
    "ACCOUNT-ERROR",
    `${first.toLowerCase()} | 错误=desktop timeout | 已确认积分=172 | 原余额=12817 | 现余额=12989 | 持续秒数=2250.2`,
    "ERROR",
  );
  ingest(
    "ACCOUNT-START",
    `开始处理账户: ${second} | geoLocale: CN | locale: zh-CN`,
  );
  ingest(
    "ACCOUNT-END",
    `账户完成: ${second} | 获得积分=1370 | 原余额=12672 | 现余额=14042 | 持续秒数=3240.8`,
  );
  ingest(
    "RUN-END",
    "本轮存在未完成账户 | 处理账户数=2 | 获得积分=1542 | 原余额=25489 | 现余额=27031 | 运行分钟数=94.4 | 失败账户数=1",
  );
  const status = {
    state: "idle",
    lastExit: {
      startedAt: "2026-11-03T01:00:00.000Z",
      at: "2026-11-03T02:34:25.296Z",
      code: 1,
    },
    run: {
      accounts: [
        {
          email: first,
          success: false,
          live: {
            gained: 172,
            balance: 12989,
            lastUpdateTs: "2026-11-03T01:31:12.714Z",
          },
        },
        { email: second, success: true },
      ],
    },
  };
  store.recordInterruptedAccounts(status);
  store.closeRunOnExit(status.lastExit);
  const histories = store.allAccountHistories();
  const accounts = mergeAccounts(
    [
      { index: 1, email: first },
      { index: 2, email: second },
    ],
    store.snapshotAccounts(),
    histories,
  );
  assert.equal(accounts[0].key, first.toLowerCase());
  assert.equal(accounts[0].email, first);
  assert.equal(accounts[0].status, "error");
  assert.equal(accounts[0].lastGained, 172);
  assert.equal(accounts[0].lastDurationSec, 2250.2);
  assert.equal(accounts[0].historyCount, 2);
  assert.equal(accounts[1].status, "success");
  assert.equal(store.snapshotAccounts().length, 2);
  assert.equal(store.accountHistory(first).length, 2);
  assert.equal(histories[first], undefined);
  const { bucketByDay, setTimeZone, accountBalance } =
    await import("../public/util.js");
  setTimeZone("Asia/Shanghai");
  const today = bucketByDay(histories[accounts[0].key]).at(-1);
  assert.equal(today.gained, 172);
  assert.equal(today.otherChange, 1);
  assert.equal(today.status, "partial");
  accounts[0].partialSnapshot = store.getPartialSnapshot(first);
  assert.equal(accountBalance(accounts[0]).balance, 12989);
  assert.equal(store.snapshotRuns()[0].status, "interrupted");
  assert.equal(store.snapshotRuns()[0].exitCode, 1);
  assert.equal(store.snapshotRuns()[0].totalGained, 1542);
});

test("legacy Chinese FLOW errors remain failures after an old zero-exit run-end message", (t) => {
  const { store, ingest } = fixture(t);
  ingest("RUN-START", "启动微软奖励脚本 | v4.3.2.4 | 账户数: 1 | 集群数: 1");
  ingest(
    "ACCOUNT-START",
    `开始处理账户: ${first} | geoLocale: CN | locale: zh-CN`,
  );
  ingest("FLOW", `${first} 的移动端流程失败: desktop timeout`, "ERROR");
  ingest(
    "RUN-END",
    "全部账户完成 | 处理账户数=1 | 获得积分=0 | 原余额=0 | 现余额=0 | 运行分钟数=37.5",
  );
  store.closeRunOnExit({
    startedAt: "2026-11-03T01:00:00Z",
    at: "2026-11-03T02:00:00Z",
    code: 0,
  });
  assert.equal(store.snapshotAccounts()[0].status, "error");
  assert.equal(store.snapshotAccounts()[0].lastError, "desktop timeout");
  assert.equal(store.snapshotRuns()[0].status, "interrupted");
  assert.equal(store.snapshotRuns()[0].exitCode, 0);
});

test("run completion without an account terminal event is unknown failure rather than success", (t) => {
  const { store, ingest } = fixture(t);
  ingest("RUN-START", "启动微软奖励脚本 | v4.3.2.4 | 账户数: 1 | 集群数: 1");
  ingest(
    "ACCOUNT-START",
    `开始处理账户: ${first} | geoLocale: CN | locale: zh-CN`,
  );
  ingest(
    "RUN-END",
    "全部账户完成 | 处理账户数=1 | 获得积分=0 | 原余额=0 | 现余额=0 | 运行分钟数=37.5",
  );
  assert.equal(store.snapshotAccounts()[0].status, "error");
  assert.match(store.snapshotAccounts()[0].lastError, /缺少完成结果/);
  assert.equal(store.snapshotRuns()[0].status, "interrupted");
});

test("unknown partial metadata stays NULL and an observed zero remains a valid known result", (t) => {
  const { store, ingest, event } = fixture(t);
  for (const [email, value] of [
    [first, "unknown"],
    [second, "0"],
  ]) {
    const parsed = event(
      "ACCOUNT-ERROR",
      `${email} | 错误=timeout | 已确认积分=${value} | 原余额=${value} | 现余额=${value} | 持续秒数=0`,
      "ERROR",
    );
    assert.equal(parsed.gained, value === "unknown" ? null : 0);
    store.apply(parsed);
  }
  ingest(
    "RUN-END",
    "本轮存在未完成账户 | 处理账户数=2 | 获得积分=unknown | 原余额=unknown | 现余额=unknown | 运行分钟数=0.1 | 失败账户数=2",
  );
  assert.equal(store.snapshotRuns()[0].status, "interrupted");
  assert.equal(store.snapshotRuns()[0].totalGained, null);
  assert.equal(
    store.snapshotAccounts().find((a) => a.email === first.toLowerCase())
      .lastGained,
    null,
  );
  assert.equal(
    store.snapshotAccounts().find((a) => a.email === second).lastGained,
    0,
  );
});

test("authoritative completion suppresses a late partial history row regardless of email case", (t) => {
  const { store } = fixture(t);
  store.db
    .prepare(
      "INSERT INTO account_history(email,ts,points,gained) VALUES(?,?,?,?)",
    )
    .run(first, "2026-11-03T01:59:00Z", 12989, 172);
  store.db
    .prepare(
      "INSERT INTO interrupted_accounts(run_id,email,ts,status,points,gained) VALUES(?,?,?,?,?,?)",
    )
    .run(
      "2026-11-03T01:00:00Z",
      first.toLowerCase(),
      "2026-11-03T02:00:00Z",
      "partial",
      12989,
      172,
    );
  assert.equal(store.accountHistory(first).length, 1);
  assert.equal(store.accountHistory(first)[0].status, "done");
  assert.equal(store.getPartialSnapshot(first), null);
  assert.equal(
    store.db.prepare("SELECT count(*) n FROM interrupted_accounts").get().n,
    1,
  );
});
