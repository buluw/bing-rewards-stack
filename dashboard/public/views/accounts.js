import * as U from "../util.js";
import { cached } from "../api.js";

let accountsPayload = null;
let rootEl = null;
let mounted = false;
let context = null;

const launching = new Set();
const refreshingBalances = new Set();
const selectedForBatch = new Set();
const expandedAccounts = new Set();
let batchRunning = false;

const SOURCE_LABELS = {
  search: "必应搜索",
  bonus: "拓展搜索",
  read: "新闻阅读",
  checkIn: "每日签到",
  claimReward: "领取奖励",
  claimBonus: "额外奖励",
  urlReward: "网页与精选",
  visualSearch: "识图搜索",
  appReward: "移动App推广",
  punchcard: "集点卡",
  searchOnBing: "探索活动",
};

async function refreshBalance(account) {
  if (!context || !account.configured || !Number.isInteger(account.index)) return;
  refreshingBalances.add(account.index);
  render(rootEl);
  try {
    const snapshot = await context.api.balance(account.index);
    context.toast('官方账目已同步：' + U.fmtNumber(snapshot.balance) + ' 积分', "success");
    context.invalidate();
    await context.refresh();
  } catch (error) {
    context.toast(error.message, "warn");
  } finally {
    refreshingBalances.delete(account.index);
    render(rootEl);
  }
}

function controlState() {
  const status = context?.status;
  const usable = Boolean(status?.reachable && status?.authOk !== false);
  const running = Boolean(status?.botRunning);
  return { usable, running };
}

async function runAccount(account) {
  if (!context || !account.configured || !Number.isInteger(account.index)) return;

  launching.add(account.index);
  render(rootEl);
  try {
    await context.api.control("start", { accountIndex: account.index });
    context.toast(
      `Started ACCOUNT_${account.index} only (${account.email}).`,
      "success",
    );
    context.invalidate();
    await context.refresh();
  } catch (error) {
    context.toast(error.message, error.status === 409 ? "warn" : "error");
  } finally {
    launching.delete(account.index);
    render(rootEl);
  }
}

function selectableAccounts() {
  return (accountsPayload?.accounts || []).filter(
    (a) => a.configured && Number.isInteger(a.index),
  );
}

async function runSelectedAccounts() {
  if (!context) return;
  const configured = selectableAccounts();
  const selectedIndexes = configured
    .filter((a) => selectedForBatch.has(a.index))
    .map((a) => a.index);
  if (!selectedIndexes.length) return;

  // The control API only accepts an exclusion list, so a "run these x of y"
  // request is expressed as "exclude everyone else".
  const excludedAccountIndexes = configured
    .filter((a) => !selectedForBatch.has(a.index))
    .map((a) => a.index);

  batchRunning = true;
  render(rootEl);
  try {
    await context.api.control("start", { excludedAccountIndexes });
    context.toast(
      `Started ${selectedIndexes.length}/${configured.length} selected accounts.`,
      "success",
    );
    context.invalidate();
    await context.refresh();
  } catch (error) {
    context.toast(error.message, error.status === 409 ? "warn" : "error");
  } finally {
    batchRunning = false;
    render(rootEl);
  }
}

function renderBatchToolbar(root) {
  const configured = selectableAccounts();
  const configuredIndexes = new Set(configured.map((a) => a.index));
  // Drop selections for accounts that disappeared (e.g. .env edited).
  for (const index of [...selectedForBatch]) {
    if (!configuredIndexes.has(index)) selectedForBatch.delete(index);
  }

  const { usable, running } = controlState();
  const count = selectedForBatch.size;
  const total = configured.length;

  U.$("#accountsSelectedCount", root).textContent = `已选 ${count}/${total};`

  const allBtn = U.$("#accountsSelectAll", root);
  allBtn.checked = total > 0 && count === total;
  allBtn.indeterminate = count > 0 && count < total;
  allBtn.disabled = total === 0;

  const runBtn = U.$("#accountsRunSelected", root);
  runBtn.disabled = !usable || running || batchRunning || count === 0;
  runBtn.textContent = batchRunning ? "Starting\u2026" : "运行所选";
}

function earnableBadge(account, live) {
  if (account.status === "success" || account.status === "done") {
    return '<span class="point-source point-source--complete" style="color:var(--positive,#10b981);font-weight:600"><strong>今日目标</strong> 已满额 ✓</span>';
  }
  const rawEarnable = live?.earnable || account.earnable || account.live?.earnable;
  const initialTotal = rawEarnable
    ? Object.values(rawEarnable).reduce((sum, points) => sum + (Number(points) || 0), 0)
    : 0;
  if (initialTotal <= 0) return '';
  const gainedSoFar = Number(live?.live?.gained || account.live?.gained || 0);
  const remaining = Math.max(0, initialTotal - gainedSoFar);
  if (remaining <= 0) {
    return '<span class="point-source point-source--complete" style="color:var(--positive,#10b981);font-weight:600"><strong>今日目标</strong> 已满额 ✓</span>';
  }
  return '<span class="point-source point-source--target"><strong>今日待赚</strong> ' + U.escapeHtml(U.fmtNumber(remaining)) + '</span>';
}

function sourceBreakdown(account, live) {
  const bySource = (live?.live?.bySource && Object.keys(live.live.bySource).length > 0)
    ? live.live.bySource
    : (account.bySource || account.live?.bySource || {});
  return Object.entries(SOURCE_LABELS)
    .filter(([source]) => Number(bySource[source]) > 0)
    .map(
      ([source, label]) =>
        '<span class="point-source"><strong>' + U.escapeHtml(label) + '</strong> ' + U.escapeHtml(U.fmtSigned(Number(bySource[source]))) + '</span>',
    )
    .join('');
}

function protectionPresentation(account) {
  if (account.streakProtectionEnabled == null) return null;

  const remaining = account.streakProtectionRemainingDays;
  const days =
    remaining == null
      ? "剩余天数未知"
      : `${remaining} protection day${remaining === 1 ? "" : "s"} left`;
  const state = account.streakProtectionEnabled ? "On" : "Off";
  const streak =
    account.streakCounter == null
      ? "streak unavailable"
      : `${U.fmtNumber(account.streakCounter)} day${account.streakCounter === 1 ? "" : "s"} current streak`;

  return {
    state,
    days,
    streak,
    pillClass:
      account.streakProtectionEnabled && remaining !== 0
        ? "pill-success"
        : remaining === 0
          ? "pill-warn"
          : "pill-idle",
  };
}

function kv(items) {
  return `<dl class="kv">${items
    .map(
      ([k, v]) =>
        `<div><dt>${U.escapeHtml(k)}</dt><dd>${U.escapeHtml(String(v))}</dd></div>`,
    )
    .join("")}</dl>`;
}

function detailGroups(a, protection) {
  const groups = [];

  groups.push([
    "配置信息",
    [
      ["已在 .env 中配置", a.configured ? "已配置" : "否 \u2014 seen in logs only"],
      ...(a.geoLocale ? [["地理区域代码", a.geoLocale]] : []),
      ...(a.langCode ? [["语言代码", a.langCode]] : []),
      ...(a.hasTotp != null ? [["TOTP 双重认证", a.hasTotp ? "Set" : "未设置"]] : []),
      ...(a.hasRecoveryEmail != null
        ? [["备用恢复邮箱", a.hasRecoveryEmail ? "Set" : "未设置"]]
        : []),
      [
        "Proxy",
        a.proxy
          ? `${a.proxy.url}${a.proxy.port ? `:${a.proxy.port}` : ""}${a.proxy.hasCredentials ? " (authenticated)" : ""}`
          : "无",
      ],
    ],
  ]);

  groups.push([
    "连击与安全保护",
    [
      ["连续成功次数", `${a.successStreak} run${a.successStreak === 1 ? "" : "s"}`],
      ...(protection
        ? [
          [
            "Current streak",
            a.streakCounter == null
              ? "Unavailable"
              : `${U.fmtNumber(a.streakCounter)} day${a.streakCounter === 1 ? "" : "s"}`,
          ],
          ["连击保护状态", protection.state === "On" ? "已开启" : "未开启"],
          [
            "Protection days remaining",
            a.streakProtectionRemainingDays == null
              ? "Unavailable"
              : `${a.streakProtectionRemainingDays} day${a.streakProtectionRemainingDays === 1 ? "" : "s"}`,
          ],
          ...(a.streakProtectionUpdatedAt
            ? [["保护状态最近检查时间", U.fmtRelative(a.streakProtectionUpdatedAt)]]
            : []),
        ]
        : []),
    ],
  ]);

  groups.push([
    "运行统计历史",
    [
      ["API 记录运行次数", U.fmtNumber(a.apiRuns)],
      ["累计获取积分 (历史)", U.fmtSigned(a.lastGained ?? a.apiTotalCollected)],
      ["上次运行时长", U.fmtDuration(a.lastDurationSec)],
      ["已载入历史点数", U.fmtNumber(a.historyCount)],
    ],
  ]);

  return `<div class="acc-detail-groups">${groups
    .map(
      ([title, items]) => `
        <div class="acc-detail-group">
            <h3 class="acc-detail-group-title">${title}</h3>
            ${kv(items)}
        </div>`,
    )
    .join("")}</div>`;
}

// Mirrors overview.js's statCard icon convention (stat-icon-check /
// -running / -alert icon-alert-active / -idle with \u2713 / \u25CF / ! / \u2013)
// so an account's live status reads the same way here as it does there.
function statusIconParts(statusKey) {
  switch (statusKey) {
    case "success":
    case "done":
      return { cls: "stat-icon-check", icon: "\u2713", label: "Success" };
    case "running":
    case "starting":
    case "stopping":
      return { cls: "stat-icon-running", icon: "\u25CF", label: U.pillParts(statusKey).label };
    case "pending":
      return { cls: "stat-icon-pending", icon: "\u25CF", label: U.pillParts(statusKey).label };
    case "error":
    case "crashed":
    case "interrupted":
    case "stopped":
      return { cls: "stat-icon-alert icon-alert-active", icon: "!", label: U.pillParts(statusKey).label };
    default:
      return { cls: "stat-icon-idle", icon: "\u2013", label: "Idle" };
  }
}

function renderAccountPanel(a, live) {
  const protection = protectionPresentation(a);
  const { usable, running } = controlState();

  // Accounts now start one at a time (accountDelay), so mid-run there can be
  // several accounts that already finished this run while another is still
  // going - `live` just means "has a record in this run", true for both.
  // a.status is this account's own last-observed outcome (idle/running/
  // success/error), so it correctly tells finished accounts apart from the
  // one actually in progress right now.
  // Mirrors overview.js: while waiting between accounts, the one named by
  // pendingDelay.nextEmail is up next, so it reads as "pending" rather than
  // whatever its last-observed status happened to be.
  const nextAccountEmail = context?.status?.pendingDelay?.nextEmail || null;
  const statusKey = launching.has(a.index)
    ? "starting"
    : a.status !== "running" && nextAccountEmail && U.normalizeEmail(a.email) === U.normalizeEmail(nextAccountEmail)
      ? "pending"
      : a.status;

  const refreshButton =
    a.configured && Number.isInteger(a.index)
      ? '<button type="button" class="btn btn-small" data-refresh-balance="' + a.index + '" ' + (!usable || running || refreshingBalances.has(a.index) ? 'disabled' : '') + ' title="从微软官方对账同步最新余额与搜索进度" style="margin-right:0.4rem">' + (refreshingBalances.has(a.index) ? '同步中…' : '对账刷新') + '</button>'
      : '';

  const runButton =
    a.configured && Number.isInteger(a.index)
      ? `<button type="button" class="btn btn-primary btn-small" data-run-account="${a.index}" ${!usable || running || launching.has(a.index) ? "disabled" : ""
      } title="仅运行 ACCOUNT_${a.index}">${launching.has(a.index) ? "Starting\u2026" : "仅运行此账号"}</button>`
      : "";

  const selectCheckbox =
    a.configured && Number.isInteger(a.index)
      ? `<label class="check acc-batch-select" title="勾选将 ACCOUNT_${a.index} 加入批量运行">
          <input type="checkbox" data-select-account="${a.index}" ${selectedForBatch.has(a.index) ? "checked" : ""}>
          <span>选择</span>
        </label>`
      : "";

  const { cls: statusIconCls, icon: statusIcon, label: statusLabel } = statusIconParts(statusKey);
  const isExpanded = expandedAccounts.has(a.key);
  const detailsId = `acc-details-${U.escapeAttr(a.key)}`;

  const chips = [
    protection
      ? `<span class="pill ${protection.pillClass}" title="${U.escapeAttr(protection.streak)}; streak protection is ${protection.state.toLowerCase()}; ${U.escapeAttr(protection.days)}">连击保护 ${protection.state === "On" ? "已开启" : "未开启"} \u00b7 ${a.streakProtectionRemainingDays == null ? "剩余天数未知" : `${a.streakProtectionRemainingDays} day${a.streakProtectionRemainingDays === 1 ? "" : "s"} left`}</span>`
      : "",
    earnableBadge(a, live),
    sourceBreakdown(a, live),
  ]
    .filter(Boolean)
    .join("");

  return `
    <div class="panel account-detail-panel">
        <div class="panel-head">
            <h2>


                <button type="button" class="acc-detail-toggle" data-toggle-details="${U.escapeAttr(a.key)}" aria-expanded="${isExpanded}" aria-controls="${detailsId}" title="${isExpanded ? "折叠详情" : "展开详情"}">\u25b8</button>
                <span class="acc-status-icon ${statusIconCls}" role="img" aria-label="${U.escapeAttr(statusLabel)}" title="${U.escapeAttr(statusLabel)}">${statusIcon}</span>${U.escapeHtml(a.email)}
            </h2>
            ${a.index != null ? `<span class="tag-mini acc-tag-account-id">ACCOUNT_${a.index}</span>` : ""}
            ${a.configured ? "" : '<span class="tag-mini">unconfigured</span>'}
            <span class="acc-detail-actions">
                <span class="acc-status-pill">${U.statusPill(statusKey)}</span>
                ${selectCheckbox}
                ${refreshButton}
                ${runButton}
            </span>
        </div>
        <div class="panel-body" id="${detailsId}" ${isExpanded ? "" : "hidden"}>
            ${detailGroups(a, protection)}
        </div>
        ${chips ? `<div class="account-today-row">
            <span class="account-today-label">今日统计</span>
            <div class="account-today-chips">${chips}</div>
        </div>` : ""}
    </div>`;
}

function render(root) {
  const container = U.$("#accountsContainer", root);
  const accounts = accountsPayload?.accounts || [];

  const liveByEmail = new Map(
    (context?.status?.bot?.run?.accounts || []).map((la) => [la.email, la]),
  );

  const errEl = U.$("#accountsError", root);
  if (errEl) {
    errEl.hidden = !accountsPayload?.apiError;
    if (accountsPayload?.apiError) errEl.textContent = accountsPayload.apiError;
  }

  if (!accounts.length) {
    container.innerHTML = '<p class="empty-note" style="padding:1.25rem">暂无已配置或检测到的账号。</p>';
    renderBatchToolbar(root);
    return;
  }

  container.innerHTML = accounts.map(a => {
    const live = liveByEmail.get(a.email) || null;
    return renderAccountPanel(a, live);
  }).join("");

  container.querySelectorAll("button[data-run-account]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const index = Number(btn.dataset.runAccount);
      const account = accounts.find((a) => a.index === index);
      if (account) runAccount(account);
    }),
  );

  container.querySelectorAll("input[data-select-account]").forEach((input) =>
    input.addEventListener("change", () => {
      const index = Number(input.dataset.selectAccount);
      if (input.checked) selectedForBatch.add(index);
      else selectedForBatch.delete(index);
      renderBatchToolbar(root);
    }),
  );

  container.querySelectorAll("button[data-toggle-details]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.dataset.toggleDetails;
      if (expandedAccounts.has(key)) expandedAccounts.delete(key);
      else expandedAccounts.add(key);
      render(root);
    }),
  );

  renderBatchToolbar(root);
}

export default {
  id: "accounts",
  label: "账号管理",
  interval: 10000,

  mount(root, ctx) {
    rootEl = root;
    context = ctx;
    root.innerHTML = `
      <p class="notice notice--warn" id="accountsError" hidden></p>
      <div class="panel batch-select-box" id="accountsBatchToolbar">
          <div class="batch-select-header">
              <h2 class="batch-select-title">批量操作</h2>
              <div class="batch-select-controls">
                  <label class="check">
                      <input type="checkbox" id="accountsSelectAll">
                      <span>全选</span>
                  </label>
                  <span class="hint" id="accountsSelectedCount">0/0 已选</span>
                  <button type="button" class="btn btn-primary btn-small" id="accountsRunSelected" disabled>运行所选账号</button>
              </div>
          </div>
      </div>
      <div id="accountsContainer">
          <p class="empty-note" style="padding:1.25rem">正在加载账号配置详情&hellip;</p>
      </div>
      <p class="hint" style="margin-top: 1.5rem;">账号统一在机器人的 <code>.env</code> 中配置（<code>ACCOUNT_N_*</code>）。控制 API 仅展示邮箱账号，绝不会下发密码、恢复邮箱、TOTP 密钥或代理凭据。</p>
    `;
    mounted = true;

    U.$("#accountsSelectAll", root).addEventListener("change", (e) => {
      const configured = selectableAccounts();
      if (e.target.checked) configured.forEach((a) => selectedForBatch.add(a.index));
      else selectedForBatch.clear();
      render(root);
    });

    U.$("#accountsRunSelected", root).addEventListener("click", () => {
      runSelectedAccounts();
    });
  },

  async refresh(ctx) {
    context = ctx;
    accountsPayload = await cached("accounts", ctx.api.accounts, 5000);
    this.redraw(ctx);
  },

  redraw(ctx) {
    context = ctx || context;
    if (!mounted || !accountsPayload) return;
    render(rootEl);
  }
};
