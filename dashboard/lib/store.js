"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { normalizeEmail } = require("./accounts");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "dashboard.sqlite");

const MAX_ACTIVITY_ROWS = 5000;

// Last-resort cutoff for a 'running' row whose account roster never filled
// (see the run-start case in apply() below) - e.g. the process died after
// only 1 of N accounts ever started, so nothing will ever complete that
// roster to trigger the normal check. Deliberately very long: a user can
// configure any number of accounts, the first run of the day can take hours
// to work through all of them, and any single account can sit blocked far
// longer still waiting on a manual login-approval prompt - so this only
// exists to bound a truly abandoned run, not to police normal durations.
const RUN_STALE_BACKSTOP_MS = 20 * 60 * 60 * 1000;

// How long to wait after the last ACCOUNT-END/ACCOUNT-ERROR before assuming
// the bot's own RUN-END is never coming and closing the run ourselves. The
// bot normally logs RUN-END within ~1s of the last account finishing; this
// only kicks in for a known bot-side clustering bug where worker-exit
// tracking undercounts and the run's own master process waits forever for
// exits that already happened, so RUN-END never fires despite every account
// having actually completed.
const AUTO_CLOSE_GRACE_MS = 15 * 1000;

// No legitimate run takes more than a couple minutes to log its very first
// ACCOUNT-START - the app logs it within ~1s of RUN-START in every observed
// case. accountDelay/manual-login waits only explain a SUBSEQUENT account
// being slow to start, never the first one. So "zero accounts started" this
// long after RUN-START is a much stronger and much faster signal of a dead
// process than RUN_STALE_BACKSTOP_MS's 20-hour window (which exists for a
// different problem: a run that died partway through a roster that DID
// start filling). Kept deliberately short.
const ZERO_START_STALE_MS = 5 * 60 * 1000;

// General safety net for a run that hangs PARTWAY through - e.g. the
// process deadlocks on a local resource (observed in production: a
// "database is locked" error from the bot's own local cache DB) without
// crashing, exiting any worker, or logging anything else ever again. Unlike
// ZERO_START_STALE_MS this can't be just a few minutes, since a run
// legitimately produces bursty gaps (accountDelay waits, slow searches) -
// but a run that's produced ABSOLUTELY NOTHING for this long, across every
// account, is well beyond any gap seen in normal operation.
const RUN_NO_ACTIVITY_STALE_MS = 180 * 60 * 1000;

// How often the zero-start watchdog checks, independent of incoming events -
// needed because a run stuck in the zero-start state produces no further
// log lines at all to trigger a check from apply().
const ZERO_START_WATCHDOG_INTERVAL_MS = 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS accounts (
    email TEXT PRIMARY KEY,
    user_name TEXT,
    geo_locale TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    last_start_at TEXT,
    last_end_at TEXT,
    last_gained INTEGER,
    last_points INTEGER,
    last_duration_sec REAL,
    last_error TEXT,
    streak_protection_enabled INTEGER,
    streak_protection_remaining_days INTEGER,
    streak_counter INTEGER,
    streak_protection_updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS account_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    ts TEXT NOT NULL,
    points INTEGER NOT NULL,
    gained INTEGER NOT NULL,
    duration_sec REAL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_history_email_ts ON account_history(email, ts);
CREATE INDEX IF NOT EXISTS idx_history_identity_ts ON account_history(lower(trim(email)), ts);

CREATE TABLE IF NOT EXISTS interrupted_accounts (
    run_id TEXT NOT NULL,
    email TEXT NOT NULL,
    ts TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('partial', 'not-started')),
    points INTEGER,
    gained INTEGER,
    PRIMARY KEY (run_id, email)
) STRICT;
DROP VIEW IF EXISTS script_point_history;
CREATE VIEW script_point_history AS
    SELECT email, ts, points, gained, duration_sec, 'done' AS status FROM account_history
    UNION ALL
    SELECT email, ts, points, gained, NULL AS duration_sec, status FROM interrupted_accounts AS i
    WHERE NOT EXISTS (
        SELECT 1 FROM account_history AS h WHERE lower(trim(h.email)) = lower(trim(i.email))
        AND julianday(h.ts) BETWEEN julianday(i.run_id) AND julianday(i.ts)
    );

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    start_ts TEXT,
    end_ts TEXT,
    version TEXT,
    total_accounts INTEGER,
    clusters INTEGER,
    accounts_processed INTEGER,
    total_gained INTEGER,
    old_total INTEGER,
    new_total INTEGER,
    runtime_min REAL,
    exit_code INTEGER,
    exit_signal TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_runs_start ON runs(start_ts);

CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    level TEXT,
    title TEXT,
    kind TEXT,
    user_name TEXT,
    platform TEXT,
    email TEXT,
    message TEXT,
    raw TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts);
`;

class Store {
  constructor({ dataDir = DATA_DIR } = {}) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, path.basename(DB_FILE)));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
    this._migrate();
    this._prepare();
    this._lastTs = this._readMeta("lastTs");
    this._autoCloseTimer = null;
    // Ephemeral (not persisted) - transient "waiting between accounts" state
    // is only meaningful while live, unlike everything else in this class.
    this._pendingDelay = null;

    // Completion evidence for the currently running process. Deliberately
    // NOT persisted - describes evidence from the live log stream only. If
    // the dashboard restarts, it should not assume an old process completed
    // successfully merely because it had partial evidence before restart.
    this._resetCompletionEvidence();

    // Watchdog for runs whose very first account never even logged
    // ACCOUNT-START (see _tryCloseZeroStartRun below for why this needs its
    // own, much shorter timeout than RUN_STALE_BACKSTOP_MS). Runs
    // independently of incoming events, since a truly dead run produces no
    // further events to trigger a check.
    this._zeroStartWatchdog = setInterval(() => {
      try {
        this._tryCloseZeroStartRun();
      } catch {
        /* best-effort safety net */
      }
      try {
        this._tryCloseStaleNoActivityRun();
      } catch {
        /* best-effort safety net */
      }
    }, ZERO_START_WATCHDOG_INTERVAL_MS);
    if (this._zeroStartWatchdog.unref) this._zeroStartWatchdog.unref();
  }

  _migrate() {
    const runCols = new Set(
      this.db
        .prepare("PRAGMA table_info(runs)")
        .all()
        .map((c) => c.name),
    );
    if (!runCols.has("exit_code"))
      this.db.exec("ALTER TABLE runs ADD COLUMN exit_code INTEGER");
    if (!runCols.has("exit_signal"))
      this.db.exec("ALTER TABLE runs ADD COLUMN exit_signal TEXT");

    const accountCols = new Set(
      this.db
        .prepare("PRAGMA table_info(accounts)")
        .all()
        .map((c) => c.name),
    );
    const accountMigrations = [
      ["streak_protection_enabled", "INTEGER"],
      ["streak_protection_remaining_days", "INTEGER"],
      ["streak_counter", "INTEGER"],
      ["streak_protection_updated_at", "TEXT"],
    ];
    for (const [name, type] of accountMigrations) {
      if (!accountCols.has(name))
        this.db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${type}`);
    }
  }

  _prepare() {
    this.stmts = {
      getMeta: this.db.prepare("SELECT value FROM meta WHERE key = ?"),
      setMeta: this.db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ),

      upsertAccountStart: this.db.prepare(`
                INSERT INTO accounts (email, user_name, geo_locale, status, last_start_at)
                VALUES (?, ?, ?, 'running', ?)
                ON CONFLICT(email) DO UPDATE SET
                    user_name = excluded.user_name,
                    geo_locale = excluded.geo_locale,
                    status = 'running',
                    last_start_at = excluded.last_start_at
            `),
      upsertAccountEnd: this.db.prepare(`
                INSERT INTO accounts (email, user_name, status, last_end_at, last_gained, last_points, last_duration_sec, last_error)
                VALUES (?, ?, 'success', ?, ?, ?, ?, NULL)
                ON CONFLICT(email) DO UPDATE SET
                    status = 'success',
                    last_end_at = excluded.last_end_at,
                    last_gained = excluded.last_gained,
                    last_points = excluded.last_points,
                    last_duration_sec = excluded.last_duration_sec,
                    last_error = NULL
            `),
      upsertAccountError: this.db.prepare(`
                INSERT INTO accounts (email, status, last_end_at, last_error, last_duration_sec, last_gained)
                VALUES (?, 'error', ?, ?, ?, ?)
                ON CONFLICT(email) DO UPDATE SET
                    status = 'error',
                    last_end_at = excluded.last_end_at,
                    last_error = excluded.last_error,
                    last_duration_sec = excluded.last_duration_sec,
                    last_gained = excluded.last_gained
            `),
      upsertStreakProtection: this.db.prepare(`
                INSERT INTO accounts (
                    email, user_name, status, streak_protection_enabled,
                    streak_protection_remaining_days, streak_counter,
                    streak_protection_updated_at
                )
                VALUES (?, ?, 'idle', ?, ?, ?, ?)
                ON CONFLICT(email) DO UPDATE SET
                    user_name = excluded.user_name,
                    streak_protection_enabled = excluded.streak_protection_enabled,
                    streak_protection_remaining_days = excluded.streak_protection_remaining_days,
                    streak_counter = excluded.streak_counter,
                    streak_protection_updated_at = excluded.streak_protection_updated_at
            `),
      insertHistory: this.db.prepare(
        "INSERT INTO account_history (email, ts, points, gained, duration_sec) VALUES (?, ?, ?, ?, ?)",
      ),
      historyForEmail: this.db.prepare(
        "SELECT ts, points, gained, duration_sec as durationSec, status FROM script_point_history WHERE lower(trim(email)) = ? ORDER BY julianday(ts), ts",
      ),
      allAccounts: this.db.prepare(`
                SELECT email, user_name as userName, geo_locale as geoLocale, status,
                       last_start_at as lastStartAt, last_end_at as lastEndAt,
                       last_gained as lastGained, last_points as lastPoints,
                       (SELECT MAX(h.ts) FROM account_history AS h WHERE lower(trim(h.email)) = lower(trim(accounts.email))) AS lastPointsAt,
                       last_duration_sec as lastDurationSec, last_error as lastError,
                       streak_protection_enabled as streakProtectionEnabled,
                       streak_protection_remaining_days as streakProtectionRemainingDays,
                       streak_counter as streakCounter,
                       streak_protection_updated_at as streakProtectionUpdatedAt
                FROM accounts
                ORDER BY COALESCE(last_end_at, last_start_at) DESC
            `),

      insertRunStart: this.db.prepare(`
                INSERT INTO runs (id, status, start_ts, version, total_accounts, clusters)
                VALUES (?, 'running', ?, ?, ?, ?)
                ON CONFLICT(id) DO NOTHING
            `),
      findRunningRun: this.db.prepare(
        `SELECT id, start_ts as startTs, total_accounts as totalAccounts FROM runs WHERE status = 'running' ORDER BY start_ts DESC LIMIT 1`,
      ),
      accountsStartedSince: this.db.prepare(`
                SELECT COUNT(DISTINCT email) as n
                FROM activity
                WHERE title = 'ACCOUNT-START' AND email IS NOT NULL AND ts >= ?
            `),
      accountsResolvedSince: this.db.prepare(`
                SELECT COUNT(DISTINCT email) as n, MAX(ts) as lastTs
                FROM activity
                WHERE title IN ('ACCOUNT-END', 'ACCOUNT-ERROR') AND email IS NOT NULL AND ts >= ?
            `),
      failedAccountsWindow: this.db.prepare(`
                SELECT COUNT(DISTINCT lower(trim(email))) AS n FROM activity
                WHERE kind = 'account-error' AND email IS NOT NULL
                AND julianday(ts) BETWEEN julianday(?) AND julianday(?)
            `),
      lastActivitySince: this.db.prepare(`
                SELECT MAX(ts) as ts FROM activity WHERE ts >= ?
            `),
      lastLoginPromptKindSince: this.db.prepare(`
                SELECT kind FROM activity
                WHERE ts >= ? AND kind IN ('login-number', 'login-number-resolved')
                ORDER BY ts DESC LIMIT 1
            `),
      sumHistorySince: this.db.prepare(`
                SELECT COALESCE(SUM(gained), 0) as gained, COALESCE(SUM(points), 0) as points, COUNT(gained) AS known
                FROM script_point_history WHERE ts >= ?
            `),
      sumHistoryWindow: this.db.prepare(`
                SELECT SUM(gained) AS gained, SUM(points) AS points, COUNT(gained) AS known
                FROM script_point_history WHERE julianday(ts) BETWEEN julianday(?) AND julianday(?)
            `),

      closeRun: this.db.prepare(`
                UPDATE runs SET status = 'done', end_ts = ?, accounts_processed = ?,
                    total_gained = ?, old_total = ?, new_total = ?, runtime_min = ?
                WHERE id = ?
            `),
      insertOrphanRunEnd: this.db.prepare(`
                INSERT INTO runs (id, status, end_ts, accounts_processed, total_gained, old_total, new_total, runtime_min)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `),
      recentRuns: this.db.prepare(`
                SELECT id, status, start_ts as startTs, end_ts as endTs, version,
                       total_accounts as totalAccounts, clusters,
                       accounts_processed as accountsProcessed, total_gained as totalGained,
                       old_total as oldTotal, new_total as newTotal, runtime_min as runtimeMin,
                       exit_code as exitCode, exit_signal as exitSignal
                FROM runs ORDER BY COALESCE(start_ts, end_ts) DESC LIMIT ?
            `),
      // Unified terminal-state closer used whenever we're ending a run
      // without the bot's own authoritative RUN-END data (crash/stop/
      // interrupt/auto-close) - stats are derived from account_history
      // instead, see _closeRunningRun().
      closeRunFull: this.db.prepare(`
                UPDATE runs SET status = ?, end_ts = ?, accounts_processed = ?,
                    total_gained = ?, old_total = ?, new_total = ?, runtime_min = ?,
                    exit_code = ?, exit_signal = ?
                WHERE id = ?
            `),
      orphanedRunningAccounts: this.db.prepare(
        "SELECT email FROM accounts WHERE status = 'running' AND last_start_at >= ?",
      ),
      markAccountInterrupted: this.db.prepare(`
                UPDATE accounts SET status = 'error', last_end_at = ?, last_error = ?, last_gained = NULL, last_duration_sec = NULL
                WHERE email = ? AND status = 'running'
            `),
      // A run ending does not prove an account succeeded. Missing account
      // results must remain errors rather than becoming synthetic successes.
      markAccountMissingResult: this.db.prepare(`
                UPDATE accounts SET status = 'error', last_end_at = ?, last_error = ?, last_gained = NULL, last_duration_sec = NULL
                WHERE email = ? AND status = 'running'
            `),
      allHistories: this.db.prepare(`
                SELECT email, ts, points, gained, duration_sec as durationSec, status
                FROM script_point_history
                ORDER BY lower(trim(email)), julianday(ts), ts
            `),
      allHistoriesSince: this.db.prepare(`
                SELECT email, ts, points, gained, duration_sec as durationSec, status
                FROM script_point_history
                WHERE ts >= ?
                ORDER BY lower(trim(email)), julianday(ts), ts
            `),

      insertActivity: this.db.prepare(`
                INSERT INTO activity (ts, level, title, kind, user_name, platform, email, message, raw)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
      recentActivity: this.db.prepare(`
                SELECT ts, level, title, kind, user_name as userName, platform, email, message, raw
                FROM activity ORDER BY id DESC LIMIT ?
            `),
      countActivity: this.db.prepare("SELECT COUNT(*) as n FROM activity"),
      pruneActivity: this.db.prepare(`
                DELETE FROM activity WHERE id IN (
                    SELECT id FROM activity ORDER BY id ASC LIMIT ?
                )
            `),
    };
  }

  _readMeta(key) {
    const row = this.stmts.getMeta.get(key);
    return row ? row.value : null;
  }

  _writeMeta(key, value) {
    this.stmts.setMeta.run(key, value);
  }

  get lastTs() {
    return this._lastTs;
  }

  // Null once no wait is in progress (never set, resolved by the next
  // ACCOUNT-START, or cleared because the run itself ended/closed).
  get pendingDelay() {
    return this._pendingDelay;
  }

  _resetCompletionEvidence() {
    this._workersExitedCleanly = false;
    this._workersExitedAt = null;
    this._anyWorkerExitedUncleanly = false;

    this._successfulWrapperCompletion = false;
    this._successfulWrapperCompletionAt = null;
    this._wrapperFailureSeen = false;
  }

  // Successful completion requires BOTH:
  //   1. The final cluster worker exited with Code 0, no signal, and
  //      Active workers: 0, AND no other worker this run ever exited
  //      uncleanly (see the cluster-worker-exit case in apply()).
  //   2. The wrapper reported successful completion.
  // This is the fallback for the bot-side clustering bug where RUN-END
  // itself never gets logged even though the process really did finish
  // cleanly - it must NOT fire on its own from "Lock released"/"Script
  // finished" alone, since those also happen after crashes/kills.
  _tryCloseFromSuccessfulProcessCompletion(eventTs) {
    const running = this.stmts.findRunningRun.get();
    if (!running) return false;
    if (!this._workersExitedCleanly || !this._successfulWrapperCompletion) {
      return false;
    }

    const endTs =
      this._successfulWrapperCompletionAt ||
      this._workersExitedAt ||
      eventTs ||
      new Date().toISOString();

    const totals = this.stmts.sumHistorySince.get(running.startTs);
    const resolved = this.stmts.accountsResolvedSince.get(running.startTs);
    const missing = this.stmts.orphanedRunningAccounts.all(running.startTs);
    const incomplete = missing.length > 0 || this.stmts.failedAccountsWindow.get(running.startTs, endTs).n > 0;
    const gained = incomplete && !totals.known ? null : totals.gained || 0;
    const newTotal = incomplete ? null : totals.points || 0;
    const oldTotal = newTotal == null ? null : newTotal - gained;
    const runtimeMin = Number(
      ((Date.parse(endTs) - Date.parse(running.startTs)) / 60000).toFixed(1),
    );

    this.stmts.closeRunFull.run(
      incomplete ? "interrupted" : "done",
      endTs,
      resolved.n || 0,
      gained,
      oldTotal,
      newTotal,
      runtimeMin,
      incomplete ? null : 0,
      null,
      running.id,
    );

    // Process completion cannot replace missing account-level evidence.
    for (const row of missing) {
      this.stmts.markAccountMissingResult.run(
        endTs,
        "本轮已结束，但该账号缺少完成结果，按中断处理。",
        row.email,
      );
    }

    this._pendingDelay = null;
    this._resetCompletionEvidence();
    return true;
  }

  // Watchdog for a run whose first account never even started (see
  // ZERO_START_STALE_MS above). Left unhandled, this also wedges every
  // future run: the run-start echo check below treats "roster incomplete"
  // as "same run continuing" for up to RUN_STALE_BACKSTOP_MS (20h), and a
  // run with zero accounts started can NEVER complete its roster, so every
  // subsequent RUN-START within that window would otherwise be silently
  // swallowed as a supposed echo of this dead run instead of starting a new
  // one.
  _tryCloseZeroStartRun() {
    const running = this.stmts.findRunningRun.get();
    if (!running) return;

    const startedCount = this.stmts.accountsStartedSince.get(running.startTs).n;
    if (startedCount > 0) return;

    const ageMs = Date.now() - Date.parse(running.startTs);
    if (!Number.isFinite(ageMs) || ageMs < ZERO_START_STALE_MS) return;

    this._closeRunningRun(running, "stalled", new Date().toISOString());
  }

  // General safety net for a run that hung PARTWAY through - covers the
  // zero-start case too (no activity since start is a special case of "no
  // activity for a long time"), but is deliberately much more generous
  // (RUN_NO_ACTIVITY_STALE_MS) since a run that already has accounts in
  // flight can have legitimate bursty gaps that a brand-new run can't.
  //
  // Explicitly does NOT fire while the run is waiting on a still-open
  // manual login-approval prompt - that can legitimately take a long time
  // (this is exactly why RUN_STALE_BACKSTOP_MS is 20h instead of something
  // short), and is a real, expected reason for silence rather than a hang.
  _tryCloseStaleNoActivityRun() {
    const running = this.stmts.findRunningRun.get();
    if (!running) return;

    const lastActivity = this.stmts.lastActivitySince.get(running.startTs);
    const lastTs = (lastActivity && lastActivity.ts) || running.startTs;
    const ageMs = Date.now() - Date.parse(lastTs);
    if (!Number.isFinite(ageMs) || ageMs < RUN_NO_ACTIVITY_STALE_MS) return;

    const pendingApproval = this.stmts.lastLoginPromptKindSince.get(running.startTs);
    if (pendingApproval && pendingApproval.kind === "login-number") return;

    this._closeRunningRun(running, "stalled", new Date().toISOString());
  }

  _pushActivity(event) {
    this.stmts.insertActivity.run(
      event.ts,
      event.level || null,
      event.title || null,
      event.kind || null,
      event.userName || null,
      event.platform || null,
      event.email || null,
      event.message || null,
      event.raw || null,
    );
    const { n } = this.stmts.countActivity.get();
    if (n > MAX_ACTIVITY_ROWS) {
      this.stmts.pruneActivity.run(n - MAX_ACTIVITY_ROWS);
    }
  }

  apply(event) {
    if (!event || !event.ts) return false;
    if (event.email) {
      const key = normalizeEmail(event.email);
      const existing = this.db.prepare("SELECT email FROM accounts WHERE lower(trim(email)) = ? ORDER BY COALESCE(last_start_at,last_end_at) DESC LIMIT 1").get(key);
      event = { ...event, email: existing?.email || key };
    }

    if (this._lastTs && event.ts <= this._lastTs) {
      return false;
    }
    this._lastTs = event.ts;
    this._writeMeta("lastTs", event.ts);

    let changed = true;

    switch (event.kind) {
      case "account-start": {
        if (!this._pendingDelay || !this._pendingDelay.nextEmail || this._pendingDelay.nextEmail === event.email) {
          this._pendingDelay = null;
        }
        this.stmts.upsertAccountStart.run(
          event.email,
          event.userName || null,
          event.geoLocale || null,
          event.ts,
        );
        this._pushActivity(event);
        break;
      }
      case "account-end": {
        this.stmts.upsertAccountEnd.run(
          event.email,
          event.userName || null,
          event.ts,
          event.gained,
          event.newPoints,
          event.durationSec,
        );
        this.stmts.insertHistory.run(
          event.email,
          event.ts,
          event.newPoints,
          event.gained,
          event.durationSec,
        );
        this._pushActivity(event);
        this._scheduleAutoCloseCheck();
        break;
      }
      case "account-error": {
        if (event.email) {
          this.stmts.upsertAccountError.run(event.email, event.ts, event.error, event.durationSec ?? null, event.gained ?? null);
        }
        this._pushActivity(event);
        this._scheduleAutoCloseCheck();
        break;
      }
      case "account-delay": {
        this._pendingDelay = {
          seconds: event.seconds,
          sinceTs: event.ts,
          nextEmail: event.nextEmail || null,
        };
        this._pushActivity(event);
        break;
      }
      case "streak-protection": {
        this.stmts.upsertStreakProtection.run(
          event.email,
          event.userName || null,
          event.enabled ? 1 : 0,
          event.remainingDays,
          event.streakCounter,
          event.ts,
        );
        break;
      }
      case "run-start": {
        // With clustering on, the bot logs one RUN-START line per worker
        // spawned for the SAME run, not once per run - e.g. Clusters: 3
        // can produce several near-identical RUN-START lines, one per
        // worker, and workers have been observed spawning minutes apart
        // rather than seconds (accountDelay-dependent) - so elapsed time
        // alone can't tell an echo apart from a genuinely new run. Only
        // the first one (nothing currently 'running') starts a new row;
        // later ones for the same run are redundant echoes and must be
        // ignored, not treated as evidence the previous row crashed.
        //
        // Use the account roster instead of a clock: while the currently
        // 'running' row hasn't yet seen ACCOUNT-START for all the accounts
        // it declared, any further RUN-START is still just another worker
        // of that same run. Once every declared account has started, the
        // roster is complete and a new RUN-START can only mean a new run -
        // this also catches a 'running' row stuck by a lost RUN-END/exit
        // signal (e.g. a container restart mid-run, or a missed cluster
        // worker exit), which otherwise permanently wedges every future run
        // (this event would be dropped forever, never even reaching the
        // activity feed, and any later RUN-END would misattribute to that
        // ancient row instead of getting a fresh one of its own).
        //
        // The one gap the roster check can't cover is a run that died
        // before its roster ever filled (e.g. crashed after account 1 of
        // 3) - nothing will ever complete that roster, so fall back to a
        // generous time backstop just for that case.
        this._resetCompletionEvidence();

        const alreadyRunning = this.stmts.findRunningRun.get();
        if (alreadyRunning) {
          const startedCount = alreadyRunning.totalAccounts
            ? this.stmts.accountsStartedSince.get(alreadyRunning.startTs).n
            : 0;
          const rosterIncomplete =
            alreadyRunning.totalAccounts != null && startedCount < alreadyRunning.totalAccounts;
          const ageMs = Date.parse(event.ts) - Date.parse(alreadyRunning.startTs);
          const withinBackstop = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < RUN_STALE_BACKSTOP_MS;
          // A run whose roster never even started (startedCount === 0) can
          // never complete its roster, so it would otherwise look like an
          // "echo" forever (up to the 20h backstop) and swallow every
          // subsequent RUN-START. The zero-start watchdog normally closes
          // these well before another RUN-START arrives, but this is a
          // safety net for e.g. the dashboard process itself having
          // restarted and lost that timer.
          const zeroStartStale =
            startedCount === 0 &&
            Number.isFinite(ageMs) &&
            ageMs >= ZERO_START_STALE_MS;
          const isEcho = rosterIncomplete && withinBackstop && !zeroStartStale;
          if (isEcho) {
            changed = false;
            break;
          }
          // We only know a new run started before the old one finished
          // normally - not why (could be a real crash, or just as likely an
          // intentional container recreate, e.g. pulling an updated image
          // mid-run). "interrupted" reflects that honestly instead of
          // guessing "crashed". markInterruptedByBackendRestart() below
          // handles the common container-recreate case immediately instead
          // of leaving it to this backstop.
          this._closeRunningRun(
            alreadyRunning,
            zeroStartStale ? "stalled" : "interrupted",
            event.ts,
          );
        }
        this.stmts.insertRunStart.run(
          event.ts,
          event.ts,
          event.version,
          event.totalAccounts,
          event.clusters,
        );
        this._pushActivity(event);
        break;
      }
      case "cluster-worker-exit": {
        // Worker PIDs are deliberately irrelevant to the decision - every
        // account can have a different PID and every run can use completely
        // different PIDs.
        //
        // IMPORTANT: an earlier worker in the same run can exit uncleanly
        // (crash/signal) before a LATER worker happens to be the one that
        // reports "Active workers: 0". Only checking the final exit line
        // would miss that earlier crash, so an unclean exit is latched for
        // the whole run and blocks treating a later clean "Active workers:
        // 0" line as proof the overall process completed cleanly.
        const exitedCleanly = event.code === 0 && event.signal == null;
        if (!exitedCleanly) {
          this._anyWorkerExitedUncleanly = true;
        }
        if (
          exitedCleanly &&
          event.activeWorkers === 0 &&
          !this._anyWorkerExitedUncleanly
        ) {
          this._workersExitedCleanly = true;
          this._workersExitedAt = event.ts;
          // May close the run immediately if wrapper completion evidence
          // already arrived.
          this._tryCloseFromSuccessfulProcessCompletion(event.ts);
        }
        this._pushActivity(event);
        break;
      }
      case "wrapper-script-completed": {
        // "Script completed successfully (via API)." is an explicit,
        // unambiguous positive completion signal.
        this._successfulWrapperCompletion = true;
        this._successfulWrapperCompletionAt = event.ts;
        this._tryCloseFromSuccessfulProcessCompletion(event.ts);
        this._pushActivity(event);
        break;
      }
      case "wrapper-script-finished": {
        // Weaker evidence than "Script completed successfully": some
        // wrapper versions print this unconditionally on the way out,
        // including right after "ERROR: Script failed!". Only count it as
        // completion evidence if no failure has been seen yet this run, so
        // it can't silently resurrect a run we already know failed.
        if (!this._wrapperFailureSeen) {
          this._successfulWrapperCompletion = true;
          this._successfulWrapperCompletionAt = event.ts;
          this._tryCloseFromSuccessfulProcessCompletion(event.ts);
        }
        this._pushActivity(event);
        break;
      }
      case "wrapper-script-failed": {
        // Explicit wrapper failure is not completion evidence, and it
        // "poisons" the rest of this run so a later bare "Script finished"
        // line can't flip it back to success.
        this._wrapperFailureSeen = true;
        this._successfulWrapperCompletion = false;
        this._successfulWrapperCompletionAt = null;
        this._pushActivity(event);
        break;
      }
      case "wrapper-lock-acquired": {
        this._pushActivity({
          ...event,
          message: `Cron run starting (lock acquired, PID ${event.pid})`,
        });
        break;
      }
      case "wrapper-lock-released": {
        // Fires via run_daily.sh's bash EXIT trap, including after a
        // crash/kill - so by itself it's never proof of success. If worker +
        // wrapper evidence already proves a clean completion, this may be
        // the event that finally closes the run (e.g. if it arrived before
        // RUN-END for some reason). Otherwise, if a run is still marked
        // 'running' by the time this shows up, that's proof nothing else is
        // coming for it and it's genuinely abnormal - close it out rather
        // than leaving a permanent ghost. This only covers wrapper-invoked
        // runs (cron/RUN_ON_START); a run started directly via the
        // dashboard/API still relies on closeRunOnExit for that case.
        const closedSuccessfully = this._tryCloseFromSuccessfulProcessCompletion(
          event.ts,
        );

        if (!closedSuccessfully) {
          const stillRunning = this.stmts.findRunningRun.get();
          if (stillRunning) {
            this._closeRunningRun(stillRunning, "interrupted", event.ts);
          }
        }

        if (event.pid) {
          this._pushActivity({
            ...event,
            message: closedSuccessfully
              ? `Cron run finished successfully (lock released, PID ${event.pid})`
              : `Cron run finished (lock released, PID ${event.pid})`,
          });
        }
        break;
      }
      case "run-end": {
        this._pendingDelay = null;
        const running = this.stmts.findRunningRun.get();
        if (running) {
          const missing = this.stmts.orphanedRunningAccounts.all(running.startTs);
          const failed = Math.max(event.accountsFailed || 0, missing.length,
            this.stmts.failedAccountsWindow.get(running.startTs, event.ts).n);
          // RUN-END only ever gets logged by the app itself, so we know the
          // process didn't crash or get signaled - use closeRunFull (not
          // closeRun) so exit_code/exit_signal stay consistent with the
          // other closing paths.
          this.stmts.closeRunFull.run(
            failed ? "interrupted" : "done",
            event.ts,
            event.accountsProcessed,
            event.totalGained,
            event.oldTotal,
            event.newTotal,
            event.runtimeMin,
            failed ? null : 0,
            null,
            running.id,
          );
          // Close unresolved accounts as errors even if the process claimed
          // success. They did not supply their own completion evidence.
          for (const row of missing) {
            this.stmts.markAccountMissingResult.run(
              event.ts,
              "本轮已结束，但该账号缺少完成结果，按中断处理。",
              row.email,
            );
          }
        } else {
          this.stmts.insertOrphanRunEnd.run(
            event.ts,
            event.accountsFailed > 0 ? "interrupted" : "done",
            event.ts,
            event.accountsProcessed,
            event.totalGained,
            event.oldTotal,
            event.newTotal,
            event.runtimeMin,
          );
        }
        this._resetCompletionEvidence();
        this._pushActivity(event);
        break;
      }
      case "login-number": {
        this._pushActivity({
          ...event,
          level: "warn",
          message: `Login approval needed for ${event.userName}: select number ${event.number}`,
        });
        break;
      }
      case "progress": {
        this._pushActivity(event);
        break;
      }
      case "generic": {
        if (event.level === "warn" || event.level === "error") {
          this._pushActivity(event);
        } else {
          changed = false;
        }
        break;
      }
      default:
        changed = false;
    }

    return changed;
  }

  // Defers the stale-running-run check rather than running it inline: the
  // bot's own RUN-END normally follows within ~1s of the last account, so
  // firing immediately would race it and risk closing the run ourselves
  // right before the real RUN-END arrives, which would then find no
  // 'running' row and create a duplicate orphan instead of just updating
  // this one. Rescheduling on every account-end/error also means the timer
  // only ever fires AUTO_CLOSE_GRACE_MS after the LAST one in a batch.
  _scheduleAutoCloseCheck() {
    if (this._autoCloseTimer) clearTimeout(this._autoCloseTimer);
    this._autoCloseTimer = setTimeout(() => {
      this._autoCloseTimer = null;
      try {
        this._tryAutoCloseStaleRun();
      } catch {
        /* best-effort safety net - a miss here just leaves the row as-is */
      }
    }, AUTO_CLOSE_GRACE_MS);
    if (this._autoCloseTimer.unref) this._autoCloseTimer.unref();
  }

  // Shared terminal-state closer for any 'running' row being ended without
  // the bot's own authoritative RUN-END line (auto-close/crash/stop/
  // interrupt) - derives accountsProcessed/gained/totals from
  // account_history instead, and demotes any account this run left stuck at
  // 'running' to 'error', since nothing else is coming for it once the run
  // itself is closed.
  _closeRunningRun(running, status, endTs, { code = null, signal = null } = {}) {
    this._pendingDelay = null;
    const totals = this.stmts.sumHistoryWindow.get(running.startTs, endTs);
    const resolved = this.stmts.accountsResolvedSince.get(running.startTs);
    const partial = this.db.prepare(`
      SELECT 1 FROM interrupted_accounts
      WHERE julianday(ts) BETWEEN julianday(?) AND julianday(?) LIMIT 1
    `).get(running.startTs, endTs);
    const gained = partial && !totals.known ? null : totals.gained || 0;
    const newTotal = partial ? null : totals.points || 0;
    const oldTotal = newTotal == null ? null : newTotal - gained;
    const runtimeMin = Number(
      ((Date.parse(endTs) - Date.parse(running.startTs)) / 60000).toFixed(1),
    );

    this.stmts.closeRunFull.run(
      status,
      endTs,
      resolved.n || 0,
      gained,
      oldTotal,
      newTotal,
      runtimeMin,
      code,
      signal,
      running.id,
    );

    for (const row of this.stmts.orphanedRunningAccounts.all(running.startTs)) {
      this.stmts.markAccountInterrupted.run(
        endTs,
        "本轮在该账号完成前结束。",
        row.email,
      );
    }

    this._resetCompletionEvidence();
  }

  // Safety net for the bot-side clustering bug where a worker's exit is
  // never observed by its primary, so 'activeWorkers' never reaches 0 and
  // RUN-END is never logged even though every account actually finished.
  // Once every account the run declared (total_accounts) has resolved
  // (ACCOUNT-END or ACCOUNT-ERROR) since it started, treat the run as done
  // and derive its totals from account_history instead of waiting forever.
  _tryAutoCloseStaleRun() {
    const running = this.stmts.findRunningRun.get();
    if (!running || !running.totalAccounts) return;

    const resolved = this.stmts.accountsResolvedSince.get(running.startTs);
    if (!resolved || resolved.n < running.totalAccounts) return;

    const endTs = resolved.lastTs || new Date().toISOString();
    const failed = this.stmts.failedAccountsWindow.get(running.startTs, endTs).n > 0;
    this._closeRunningRun(running, failed ? "interrupted" : "done", endTs);
  }

  closeRunOnExit(exit) {
    if (Number.isFinite(Date.parse(exit?.startedAt)) && Number.isFinite(Date.parse(exit?.at))) {
      const closed = this.db.prepare(`SELECT id FROM runs WHERE status <> 'running'
        AND julianday(start_ts) BETWEEN julianday(?) AND julianday(?) ORDER BY start_ts DESC LIMIT 1`).get(exit.startedAt, exit.at);
      if (closed) this.db.prepare("UPDATE runs SET exit_code = ?, exit_signal = ? WHERE id = ?").run(exit.code ?? null, exit.signal ?? null, closed.id);
    }
    const running = this.stmts.findRunningRun.get();
    if (!running) return false;
    if (exit?.startedAt && (
      Date.parse(running.startTs) < Date.parse(exit.startedAt) ||
      Date.parse(running.startTs) > Date.parse(exit.at)
    )) return false;
    const code = exit?.code ?? null;
    const signal = exit?.signal ?? null;

    // A clean exit (code 0, no signal) almost always means the app already
    // logged its own RUN-END line, which the "run-end" event handler above
    // closes with the real accounts/points data. Racing ahead here would
    // stamp this row 'done' with everything NULL, then force run-end into
    // creating a second, orphaned row once it can't find this one anymore -
    // exactly the empty "Done -/N" duplicates this was producing. Only step
    // in for crashes/kills, where no RUN-END line is ever coming.
    if (!signal && code === 0) return false;

    // This path comes from the Control API directly observing its own child
    // process exit, so (unlike the "interrupted" paths above) we have real
    // evidence here: a signal means something intentionally stopped it
    // (stopped), while a bare non-zero code with no signal means the app
    // exited on its own with a failure (crashed).
    const status = signal || exit?.cancelled ? "stopped" : "crashed";
    this._closeRunningRun(
      running,
      status,
      exit?.at || new Date().toISOString(),
      { code, signal },
    );
    return true;
  }

  // Called when the dashboard detects the Control API/container itself
  // restarted mid-poll (health.uptimeSec went backwards) - a much faster and
  // more direct signal than waiting for a new RUN-START to eventually prove
  // the old row is stale. Covers container recreation for any reason
  // (image update, manual restart, OOM kill, host reboot), which is why the
  // result is "interrupted" rather than "crashed": we only know the backend
  // vanished, not why.
  //
  // notStartedAfter guards a race with the SSE log stream, which can notice
  // the same disconnect on its own and reconnect - possibly processing a
  // brand new RUN-START - before this poll-driven check runs. Only close a
  // row that was already 'running' as of the last known-good health check;
  // never one that could be that legitimate new run.
  markInterruptedByBackendRestart(at = new Date().toISOString(), { notStartedAfter = null } = {}) {
    const running = this.stmts.findRunningRun.get();
    if (!running) return false;
    if (notStartedAfter && running.startTs >= notStartedAfter) return false;
    this._closeRunningRun(running, "interrupted", at);
    return true;
  }

  // Confirmed partial results are separate from authoritative ACCOUNT-END rows.
  recordInterruptedAccounts(status, roster = []) {
    const exit = status?.lastExit;
    if (
      status?.state !== "idle" || !Array.isArray(status.run?.accounts) ||
      !Number.isFinite(Date.parse(exit?.startedAt)) || !Number.isFinite(Date.parse(exit?.at)) ||
      Date.parse(exit.at) < Date.parse(exit.startedAt)
    ) return;
    const accounts = new Map(status.run.accounts.map((account) => [
      normalizeEmail(account.email), account,
    ]));
    const targets = new Set([
      ...accounts.keys(), ...roster.map((row) => normalizeEmail(row.email)),
    ]);
    const insert = this.db.prepare(`
      INSERT INTO interrupted_accounts(run_id,email,ts,status,points,gained)
      VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,email) DO NOTHING
    `);
    const known = (value) => Number.isSafeInteger(value) && value >= 0;
    this.db.exec("BEGIN");
    try {
      for (const email of targets) {
        const account = accounts.get(email);
        if (account?.success === true) continue;
        const updated = account?.live?.lastUpdateTs;
        const observed = Number.isFinite(Date.parse(updated));
        insert.run(
          exit.startedAt, email, exit.at, account ? "partial" : "not-started",
          known(account?.live?.balance) ? account.live.balance : null,
          observed && Number.isSafeInteger(account?.live?.gained) ? account.live.gained : null,
        );
      }
      // The controller's exit log can close the run before the final status arrives.
      // Reconcile only that interrupted run, within its own time window.
      const run = this.db.prepare(`
        SELECT id,start_ts FROM runs
        WHERE julianday(start_ts) BETWEEN julianday(?) AND julianday(?)
        AND status IN ('crashed','stopped','interrupted')
        ORDER BY start_ts DESC LIMIT 1
      `).get(exit.startedAt, exit.at);
      const hasPartial = this.db.prepare(
        "SELECT 1 FROM interrupted_accounts WHERE run_id = ? LIMIT 1",
      ).get(exit.startedAt);
      if (run && hasPartial) {
        const total = this.stmts.sumHistoryWindow.get(run.start_ts, exit.at);
        this.db.prepare(
          "UPDATE runs SET total_gained = ?, old_total = NULL, new_total = NULL WHERE id = ?",
        ).run(total.gained, run.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getRecovery() {
    try {
      return JSON.parse(this._readMeta("runRecovery") || "null");
    } catch {
      return null;
    }
  }

  setRecovery(value) {
    this._writeMeta("runRecovery", JSON.stringify(value));
  }

  getRecoveryBudget() {
    try {
      return JSON.parse(this._readMeta("runRecoveryBudget") || "null");
    } catch {
      return null;
    }
  }

  setRecoveryBudget(value) {
    this._writeMeta("runRecoveryBudget", JSON.stringify(value));
  }

  getPartialSnapshot(email) {
    return this.db.prepare(`
      SELECT points AS balance, ts AS checkedAt FROM script_point_history
      WHERE lower(trim(email)) = ? AND status = 'partial' AND points IS NOT NULL ORDER BY julianday(ts) DESC LIMIT 1
    `).get(normalizeEmail(email)) || null;
  }

  getBalanceSnapshot(email) {
    const value = this._readMeta(`balance:${String(email).toLowerCase()}`);
    if (!value) return null;
    try { return JSON.parse(value); } catch { return null; }
  }

  setBalanceSnapshot(snapshot) {
    if (!snapshot.email || !Number.isSafeInteger(snapshot.balance) || snapshot.balance < 0 || !Number.isFinite(Date.parse(snapshot.checkedAt))) {
      throw new Error("余额查询结果无效，已保留上次记录。");
    }
    // An observation is not a script run. Never append it to account_history
    // or change last_gained, last_end_at, task status or scheduling state.
    this._writeMeta(`balance:${snapshot.email.toLowerCase()}`, JSON.stringify(snapshot));
  }


  getBySource(email) {
    const value = this._readMeta("sources:" + String(email).toLowerCase());
    if (!value) return null;
    try { return JSON.parse(value); } catch { return null; }
  }

  setBySource(email, bySource) {
    if (!email || !bySource || typeof bySource !== "object") return;
    this._writeMeta("sources:" + String(email).toLowerCase(), JSON.stringify(bySource));
  }

  getSchedule() {
    const raw = this._readMeta("schedule");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  setSchedule(config) {
    this._writeMeta("schedule", JSON.stringify(config));
    return config;
  }

  snapshotAccounts() {
    return this.stmts.allAccounts.all();
  }

  snapshotRuns(limit = 30) {
    return this.stmts.recentRuns.all(limit);
  }

  allAccountHistories({ since = null } = {}) {
    const rows = since
      ? this.stmts.allHistoriesSince.all(since)
      : this.stmts.allHistories.all();
    const byEmail = {};
    for (const row of rows) {
      const key = normalizeEmail(row.email);
      if (!byEmail[key]) byEmail[key] = [];
      byEmail[key].push({
        ts: row.ts,
        points: row.points,
        gained: row.gained,
        durationSec: row.durationSec,
        status: row.status,
      });
    }
    return byEmail;
  }

  snapshotActivity(limit = 100) {
    return this.stmts.recentActivity.all(limit);
  }

  accountHistory(email) {
    return this.stmts.historyForEmail.all(normalizeEmail(email));
  }

  saveNow() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  close() {
    if (this._autoCloseTimer) clearTimeout(this._autoCloseTimer);
    if (this._zeroStartWatchdog) clearInterval(this._zeroStartWatchdog);
    this.saveNow();
    this.db.close();
  }
}

module.exports = { Store };
