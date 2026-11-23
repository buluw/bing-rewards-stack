const assert = require("node:assert/strict");
const { test } = require("node:test");
const { RunRecovery } = require("../lib/runRecovery");

const startedAt = "2026-10-25T01:00:00.000Z";
const roster = {
  accounts: [
    { index: 1, email: "a@test.invalid" },
    { index: 2, email: "b@test.invalid" },
  ],
};
const clone = (value) => structuredClone(value);
const failure = (identity = startedAt, accounts = [], extra = {}) => ({
  state: "idle",
  lastExit: {
    startedAt: identity,
    at: new Date(
      Math.max(Date.parse(identity), Date.parse("2026-10-25T01:04:22.000Z")),
    ).toISOString(),
    code: 1,
    signal: null,
    cancelled: false,
    ...extra,
  },
  run: { accounts },
});

function fixture(saved = null) {
  let clock = Date.parse("2026-10-25T01:04:22Z");
  let persisted = saved;
  const calls = [];
  const observations = [];
  let enabled = true;
  let budget = null;
  let current = failure();
  const client = {
    async get(path) {
      return path === "/accounts" ? clone(roster) : current;
    },
    async post(path, body) {
      calls.push({ path, body });
      return { started: true, startedAt: new Date(clock).toISOString() };
    },
  };
  const store = {
    getRecoveryBudget: () => clone(budget),
    setRecoveryBudget: (value) => {
      budget = clone(value);
    },
    getRecovery: () => clone(persisted),
    setRecovery: (state) => {
      persisted = clone(state);
    },
    recordInterruptedAccounts: (status, remaining) =>
      observations.push({ status, remaining }),
  };
  const recovery = new RunRecovery({
    client,
    store,
    enabled: () => enabled,
    now: () => clock,
    timezone: "Asia/Shanghai",
  });
  if (!saved)
    recovery.track({ started: true, startedAt }, roster, [], startedAt);
  return {
    recovery,
    client,
    store,
    calls,
    observations,
    snapshot: () => clone(persisted),
    advance: (ms) => {
      clock += ms;
    },
    disable: () => {
      enabled = false;
    },
    setStatus: (status) => {
      current = status;
    },
  };
}

test("crash retries only unfinished accounts, waits 2 then 5 minutes, and stops after two retries", async () => {
  const f = fixture();
  let status = failure(startedAt, [{ email: "a@test.invalid", success: true }]);
  f.setStatus(status);
  await f.recovery.observe(status);
  assert.equal(f.recovery.summary().phase, "waiting");
  await f.recovery.observe(status);
  assert.equal(f.calls.length, 0);
  f.advance(120_000);
  await Promise.all([f.recovery.observe(status), f.recovery.observe(status)]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, { excludedAccountIndexes: [1] });
  const secondStart = f.snapshot().runStartedAt;
  status = failure(secondStart);
  f.setStatus(status);
  await f.recovery.observe(status);
  f.advance(299_999);
  await f.recovery.observe(status);
  assert.equal(f.calls.length, 1);
  f.advance(1);
  await f.recovery.observe(status);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].body.excludedAccountIndexes, [1]);
  const thirdStart = f.snapshot().runStartedAt;
  await f.recovery.observe(failure(thirdStart));
  assert.equal(f.recovery.pending, null);
  assert.equal(f.calls.length, 2);
});

test("an incomplete desktop search retries only account two and never restarts the completed first account", async () => {
  const f = fixture();
  const status = failure(startedAt, [
    { email: "a@test.invalid", success: true, collectedPoints: 60 },
    {
      email: "b@test.invalid",
      success: false,
      collectedPoints: 39,
      error: "Request timeout (20000 ms) exceeded.",
      live: { gained: 39, balance: 1039 },
    },
  ]);
  f.setStatus(status);
  await f.recovery.observe(status);
  assert.equal(f.recovery.summary().phase, "waiting");
  assert.deepEqual(
    f.observations.at(-1).remaining.map((row) => row.index),
    [2],
  );
  assert.equal(f.calls.length, 0);
  f.advance(120_000);
  await f.recovery.observe(status);
  assert.deepEqual(f.calls, [
    { path: "/start", body: { excludedAccountIndexes: [1] } },
  ]);
  await f.recovery.observe(
    failure(
      f.snapshot().runStartedAt,
      [{ email: "b@test.invalid", success: true, collectedPoints: 18 }],
      { code: 0 },
    ),
  );
  assert.equal(f.recovery.pending, null);
  assert.equal(f.calls.length, 1);
});

test("normal completion never triggers a retry", async () => {
  const f = fixture();
  await f.recovery.observe(
    failure(
      startedAt,
      roster.accounts.map((a) => ({ ...a, success: true })),
      { code: 0 },
    ),
  );
  assert.equal(f.recovery.pending, null);
  assert.equal(f.calls.length, 0);
});

test("account-level failure retries account one while preserving the successful second account and mixed-case mapping", async () => {
  const f = fixture();
  const status = failure(startedAt, [
    { email: "A@test.invalid", success: false },
    { email: "b@test.invalid", success: true },
  ]);
  f.setStatus(status);
  await f.recovery.observe(status);
  f.advance(120_000);
  await f.recovery.observe(status);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body.excludedAccountIndexes, [2]);
});

test("explicitly skipped accounts never become automatic retry targets", async () => {
  const f = fixture();
  const status = failure(startedAt, [
    { email: "a@test.invalid", success: false, retryable: false },
    { email: "b@test.invalid", success: true },
  ]);
  f.setStatus(status);
  await f.recovery.observe(status);
  f.advance(120_000);
  await f.recovery.observe(status);
  assert.equal(f.recovery.pending, null);
  assert.equal(f.calls.length, 0);
});

for (const exit of [
  { cancelled: true },
  { signal: "SIGTERM" },
  { code: 130 },
  { code: 137 },
  { code: 143 },
  { code: 0 },
  { code: null },
]) {
  test(
    "does not undo a manual stop or retry an ambiguous exit: " +
      JSON.stringify(exit),
    async () => {
      const f = fixture();
      await f.recovery.observe(failure(startedAt, [], exit));
      assert.equal(f.recovery.pending, null);
      assert.equal(f.calls.length, 0);
    },
  );
}

test("a manual run or backend restart cancels recovery rather than overlapping it", async () => {
  const f = fixture();
  await f.recovery.observe({
    state: "running",
    startedAt: "2026-10-25T01:01:00Z",
    run: { accounts: [] },
  });
  assert.equal(f.recovery.pending, null);
});

test("disabling the schedule cancels a pending retry", async () => {
  const f = fixture();
  await f.recovery.observe(failure());
  f.disable();
  f.advance(120_000);
  await f.recovery.observe(failure());
  assert.equal(f.recovery.pending, null);
  assert.equal(f.calls.length, 0);
});

test("never retries across local midnight", async () => {
  const f = fixture();
  await f.recovery.observe(failure());
  f.advance(24 * 60 * 60_000);
  await f.recovery.observe(failure());
  assert.equal(f.recovery.pending, null);
  assert.equal(f.calls.length, 0);
});

test("rejects changed account identities or index mappings", async () => {
  const f = fixture();
  await f.recovery.observe(failure());
  f.advance(120_000);
  f.client.get = async () => ({
    accounts: [{ index: 1, email: "replacement@test.invalid" }],
  });
  await f.recovery.observe(failure());
  assert.equal(f.recovery.pending, null);
  assert.equal(f.calls.length, 0);
});

test("rechecks backend state just before POST", async () => {
  const f = fixture();
  await f.recovery.observe(failure());
  f.advance(120_000);
  f.setStatus({ state: "running", startedAt: "another-run" });
  await f.recovery.observe(failure());
  assert.equal(f.recovery.pending, null);
  assert.equal(f.calls.length, 0);
});

test("ambiguous POST is never automatically resent", async () => {
  const f = fixture();
  await f.recovery.observe(failure());
  f.advance(120_000);
  let posts = 0;
  f.client.post = async () => {
    posts++;
    throw new Error("timeout after sending");
  };
  await f.recovery.observe(failure());
  await f.recovery.observe(failure());
  assert.equal(posts, 1);
  assert.equal(f.recovery.pending, null);
});

test("pending retry survives dashboard restart with its budget and original run identity", async () => {
  const first = fixture();
  await first.recovery.observe(failure());
  const saved = first.snapshot();
  const restored = fixture(saved);
  restored.advance(120_000);
  await restored.recovery.observe(failure());
  assert.equal(restored.calls.length, 1);
  assert.equal(restored.snapshot().retries, 1);
});

test("a restart during dispatch fails closed rather than repeating a possibly accepted start", () => {
  const f = fixture();
  const saved = f.snapshot();
  saved.phase = "dispatching";
  assert.equal(fixture(saved).recovery.pending, null);
});

test("original exclusions remain excluded when retrying", async () => {
  const f = fixture();
  f.recovery.track({ started: true, startedAt }, roster, [2], startedAt);
  await f.recovery.observe(failure());
  f.advance(120_000);
  await f.recovery.observe(failure());
  assert.deepEqual(f.calls[0].body.excludedAccountIndexes, [2]);
});

test("cancelling or shutting down while the roster is being read never starts a retry", async () => {
  for (const stop of ["cancel", "suspend"]) {
    const f = fixture();
    await f.recovery.observe(failure());
    f.advance(120_000);
    let release;
    f.client.get = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const observing = f.recovery.observe(failure());
    f.recovery[stop]();
    release(clone(roster));
    await observing;
    assert.equal(f.calls.length, 0);
    if (stop === "suspend") assert.equal(f.snapshot().phase, "waiting");
  }
});

test("a stale roster response cannot cancel a newly tracked scheduled run", async () => {
  const f = fixture();
  await f.recovery.observe(failure());
  f.advance(120_000);
  let release;
  f.client.get = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const observing = f.recovery.observe(failure());
  const newStart = "2026-10-25T03:00:00.000Z";
  f.recovery.track(
    { started: true, startedAt: newStart },
    roster,
    [],
    newStart,
  );
  release({ accounts: [] });
  await observing;
  assert.equal(f.snapshot().runStartedAt, newStart);
  assert.equal(f.calls.length, 0);
});

test("a successful retry clears its pending state and never runs completed accounts again", async () => {
  const f = fixture();
  const status = failure(startedAt, [
    { email: "a@test.invalid", success: true },
  ]);
  f.setStatus(status);
  await f.recovery.observe(status);
  f.advance(120_000);
  await f.recovery.observe(status);
  const secondStart = f.snapshot().runStartedAt;
  await f.recovery.observe(
    failure(secondStart, [{ email: "b@test.invalid", success: true }], {
      code: 0,
    }),
  );
  assert.equal(f.recovery.pending, null);
  assert.equal(f.calls.length, 1);
});

test("daily retry budget survives cancellation, another schedule and a dashboard restart; next day gets a fresh budget", async () => {
  const f = fixture();
  f.store.setRecoveryBudget({ day: "2026-10-25", used: 2 });
  f.recovery.cancel();
  let now = Date.parse("2026-10-25T04:00:00Z");
  const restored = new RunRecovery({
    client: f.client,
    store: f.store,
    enabled: () => true,
    now: () => now,
    timezone: "Asia/Shanghai",
  });
  const secondSchedule = "2026-10-25T03:00:00.000Z";
  restored.track(
    { started: true, startedAt: secondSchedule },
    roster,
    [],
    secondSchedule,
  );
  await restored.observe(failure(secondSchedule));
  assert.equal(restored.pending, null);
  assert.equal(f.calls.length, 0);
  now += 24 * 60 * 60_000;
  const nextDay = "2026-10-26T03:00:00.000Z";
  restored.track({ started: true, startedAt: nextDay }, roster, [], nextDay);
  await restored.observe(failure(nextDay));
  assert.equal(restored.summary().phase, "waiting");
  assert.equal(restored.summary().retries, 0);
});
