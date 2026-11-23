"use strict";

const RETRY_DELAYS = [2 * 60_000, 5 * 60_000];
const validTime = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const emailKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

function rosterFrom(payload) {
  if (!Array.isArray(payload?.accounts) || !payload.accounts.length)
    return null;
  const rows = payload.accounts.map(({ index, email }) => ({
    index,
    email: emailKey(email),
  }));
  if (
    rows.some(
      (row) =>
        !Number.isSafeInteger(row.index) ||
        row.index < 1 ||
        !row.email.includes("@"),
    ) ||
    new Set(rows.map((row) => row.index)).size !== rows.length ||
    new Set(rows.map((row) => row.email)).size !== rows.length
  )
    return null;
  return rows.sort((a, b) => a.index - b.index);
}

class RunRecovery {
  constructor({
    client,
    store,
    enabled,
    log = () => {},
    now = Date.now,
    timezone = process.env.TZ || "UTC",
  }) {
    Object.assign(this, { client, store, enabled, log, now, timezone });
    this.busy = false;
    this.suspended = false;
    this.pending = store.getRecovery();
    const saved = this.pending;
    if (saved && saved.blocked == null) saved.blocked = [];
    if (
      saved &&
      (!rosterFrom({ accounts: saved.roster }) ||
        !Array.isArray(saved.excluded) ||
        !saved.excluded.every(
          (index) => Number.isSafeInteger(index) && index > 0,
        ) ||
        !Array.isArray(saved.completed) ||
        !saved.completed.every((email) => typeof email === "string") ||
        !Array.isArray(saved.blocked) ||
        !saved.blocked.every((email) => typeof email === "string") ||
        !validTime(saved.scheduledAt) ||
        !validTime(saved.runStartedAt) ||
        !Number.isInteger(saved.retries) ||
        saved.retries < 0 ||
        saved.retries > RETRY_DELAYS.length ||
        !["running", "waiting"].includes(saved.phase) ||
        (saved.phase === "waiting" && !validTime(saved.dueAt)))
    ) {
      this.cancel("补跑状态不明确，已停止自动补跑");
    }
  }

  day(at) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(at));
  }

  persist() {
    this.store.setRecovery(this.pending);
  }

  usedToday() {
    const budget = this.store.getRecoveryBudget();
    if (!budget || budget.day !== this.day(this.now())) return 0;
    return Number.isInteger(budget.used) && budget.used >= 0
      ? Math.min(RETRY_DELAYS.length, budget.used)
      : RETRY_DELAYS.length;
  }

  // Keep the durable retry budget, but prevent in-flight reads from dispatching
  // after the dashboard has started closing its database and HTTP server.
  suspend() {
    this.suspended = true;
  }

  summary() {
    const pending = this.pending;
    return pending
      ? {
          phase: pending.phase,
          retries: pending.retries,
          retrying: pending.retrying === true,
          maxRetries: RETRY_DELAYS.length,
          nextRetryAt: pending.dueAt || null,
        }
      : null;
  }

  cancel(message = "自动补跑已取消") {
    if (!this.pending) return;
    this.pending = null;
    this.persist();
    this.log("info", message);
  }

  track(info, payload, excluded, scheduledAt) {
    const roster = rosterFrom(payload);
    if (
      !info?.started ||
      !validTime(info.startedAt) ||
      !roster ||
      this.day(scheduledAt) !== this.day(this.now())
    ) {
      this.cancel();
      this.log("warn", "本次运行的账号或进程标识不完整，未启用自动补跑");
      return;
    }
    this.pending = {
      phase: "running",
      scheduledAt,
      roster,
      excluded: [...excluded],
      completed: [],
      blocked: [],
      retries: this.usedToday(),
      retrying: false,
      runStartedAt: info.startedAt,
      dueAt: null,
    };
    this.persist();
  }

  async observe(status) {
    if (
      this.suspended ||
      this.busy ||
      !this.pending ||
      !status ||
      status.state === "unknown"
    )
      return;
    this.busy = true;
    try {
      await this._observe(status);
    } catch {
      this.log(
        "warn",
        "补跑状态查询暂时失败，稍后重新核对；未重复提交启动请求",
      );
    } finally {
      this.busy = false;
    }
  }

  async _observe(status) {
    const pending = this.pending;
    if (
      !this.enabled() ||
      this.day(pending.scheduledAt) !== this.day(this.now())
    ) {
      this.cancel("调度已关闭或已跨日，自动补跑已取消");
      return;
    }
    const identity =
      status.state === "idle" ? status.lastExit?.startedAt : status.startedAt;
    if (identity !== pending.runStartedAt) {
      this.cancel("运行进程已变化或后端已重启，自动补跑已取消");
      return;
    }
    const targets = pending.roster.filter(
      (account) => !pending.excluded.includes(account.index),
    );
    for (const account of status.run?.accounts || []) {
      const email = emailKey(account.email);
      if (
        account.retryable === false &&
        targets.some((row) => row.email === email) &&
        !pending.blocked.includes(email)
      ) {
        pending.blocked.push(email);
      }
      if (
        account.success === true &&
        targets.some((row) => row.email === email) &&
        !pending.completed.includes(email)
      ) {
        pending.completed.push(email);
      }
    }
    this.persist();
    if (status.state !== "idle") return;

    const remaining = targets.filter(
      (row) =>
        !pending.completed.includes(row.email) &&
        !pending.blocked.includes(row.email),
    );
    this.store.recordInterruptedAccounts(status, remaining);
    if (!remaining.length) {
      this.cancel(
        pending.blocked.length
          ? "没有可自动补跑的账号，保留明确跳过的记录"
          : pending.retries
            ? "补跑已完成，所选账号均已完成"
            : "本次定时运行已完成",
      );
      return;
    }
    const exit = status.lastExit;
    if (
      !validTime(exit.at) ||
      Date.parse(exit.at) < Date.parse(exit.startedAt) ||
      exit.cancelled ||
      exit.signal ||
      !Number.isInteger(exit.code) ||
      [0, 130, 137, 143].includes(exit.code)
    ) {
      this.cancel("任务已停止或没有明确的异常退出证据，未自动补跑");
      return;
    }
    if (pending.phase === "running") {
      if (pending.retries >= RETRY_DELAYS.length) {
        this.cancel("已达到当天最多两次补跑，保留失败记录");
        return;
      }
      pending.phase = "waiting";
      pending.dueAt = new Date(
        this.now() + RETRY_DELAYS[pending.retries],
      ).toISOString();
      this.persist();
      this.log(
        "warn",
        `任务异常退出，将在 ${RETRY_DELAYS[pending.retries] / 60_000} 分钟后补跑 ${remaining.length} 个未完成账号`,
      );
      return;
    }
    if (pending.phase !== "waiting" || this.now() < Date.parse(pending.dueAt))
      return;

    const configured = rosterFrom(await this.client.get("/accounts"));
    if (this.suspended || this.pending !== pending) return;
    if (JSON.stringify(configured) !== JSON.stringify(pending.roster)) {
      this.cancel("账号配置已变化，自动补跑已取消");
      return;
    }
    const current = await this.client.get("/status");
    if (this.suspended || this.pending !== pending) return;
    if (
      !this.enabled() ||
      this.day(pending.scheduledAt) !== this.day(this.now()) ||
      current.state !== "idle" ||
      current.lastExit?.startedAt !== pending.runStartedAt ||
      current.lastExit?.cancelled ||
      current.lastExit?.signal
    ) {
      this.cancel("启动前状态已变化，自动补跑已取消");
      return;
    }
    const remainingIndexes = new Set(remaining.map((row) => row.index));
    const excludedAccountIndexes = pending.roster
      .filter((row) => !remainingIndexes.has(row.index))
      .map((row) => row.index);
    // Persist the claim before POST: an ambiguous response must never be retried blindly.
    pending.phase = "dispatching";
    pending.retries = Math.max(pending.retries, this.usedToday()) + 1;
    if (pending.retries > RETRY_DELAYS.length) {
      this.cancel("已达到当天最多两次补跑，保留失败记录");
      return;
    }
    pending.dueAt = null;
    this.store.setRecoveryBudget({
      day: this.day(this.now()),
      used: pending.retries,
    });
    this.persist();
    let info;
    try {
      info = await this.client.post("/start", { excludedAccountIndexes });
    } catch {
      if (!this.suspended && this.pending === pending)
        this.cancel("补跑启动未被明确确认，已停止自动重试，请查看运行记录");
      return;
    }
    if (this.suspended || this.pending !== pending) return;
    if (!info?.started || !validTime(info.startedAt)) {
      this.cancel("补跑进程标识不明确，已停止自动重试");
      return;
    }
    pending.runStartedAt = info.startedAt;
    pending.retrying = true;
    pending.phase = "running";
    this.persist();
    this.log(
      "info",
      `已启动第 ${pending.retries}/2 次补跑，仅运行 ${remaining.length} 个未完成账号`,
    );
  }
}

module.exports = { RunRecovery };
