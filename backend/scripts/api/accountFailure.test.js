import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createRunState, applyLogToRunState, parseLogLine, summarizeRunState } from './logParser.js'

const require = createRequire(import.meta.url)
const { MicrosoftRewardsBot } = require('../../dist/index.js')
const humanize = require('../../dist/util/Humanize.js')
const raw = (user, title, message, level = 'INFO') =>
    `[11/3/2026, 9:00:00 AM] [${user}] [${level}] MAIN [${title}] ${message}`
const apply = (state, user, title, message, level = 'INFO') => {
    const entry = parseLogLine(raw(user, title, message, level))
    entry.receivedAt = '2026-11-03T01:37:30.000Z'
    applyLogToRunState(state, entry)
}

function taskFixture(t, { unknown = false, fail = true } = {}) {
    t.mock.method(humanize, 'markRunSucceeded', () => {})
    const bot = Object.create(MicrosoftRewardsBot.prototype)
    const logs = []
    const exitCodes = []
    Object.assign(bot, {
        config: { clusters: 1 },
        userData: {},
        logger: { info: (...args) => logs.push(args), error: (...args) => logs.push(args) },
        utils: { getEmailUsername: email => email.split('@')[0] },
        waitBeforeNextAccount: async () => {},
        sendPushPlusSummary: async () => {},
        sendServerChanSummary: async () => {},
        sendClawBotSummary: async () => {},
        Main: async account => {
            if (account.email === 'First@Test.invalid' && fail) {
                if (!unknown) {
                    bot.accountPointsReady = true
                    bot.userData.initialPoints = 12817
                    bot.userData.currentPoints = 12989
                }
                throw new Error('Rewards dashboard did not render (no section#dailyset)')
            }
            return { initialPoints: 12672, collectedPoints: 1370 }
        }
    })
    t.mock.method(process, 'exit', code => {
        exitCodes.push(code)
    })
    return {
        bot,
        logs,
        exitCodes,
        accounts: [
            { email: 'First@Test.invalid', geoLocale: 'CN', proxy: {} },
            { email: 'second@test.invalid', geoLocale: 'CN', proxy: {} }
        ]
    }
}

test('one failed account emits its partial result, keeps the second account successful and exits nonzero', async t => {
    const f = taskFixture(t)
    await f.bot.runTasks(f.accounts, Date.now() - 10000)
    assert.deepEqual(f.exitCodes, [1])
    const error = f.logs.find(([, title]) => title === 'ACCOUNT-ERROR')
    assert.match(error[2], /已确认积分=172 \| 原余额=12817 \| 现余额=12989/)
    const completed = f.logs.filter(([, title]) => title === 'ACCOUNT-END')
    assert.equal(completed.length, 1)
    assert.match(completed[0][2], /second@test.invalid/)
    const end = f.logs.find(([, title]) => title === 'RUN-END')
    assert.match(end[2], /获得积分=1542/)
    assert.match(end[2], /失败账户数=1$/)
})

test('failure before a balance observation remains unknown and never borrows another account balance', async t => {
    const f = taskFixture(t, { unknown: true })
    f.bot.userData = { initialPoints: 999, currentPoints: 1000 }
    await f.bot.runTasks(f.accounts, Date.now())
    const error = f.logs.find(([, title]) => title === 'ACCOUNT-ERROR')
    assert.match(error[2], /已确认积分=unknown \| 原余额=unknown \| 现余额=unknown/)
    assert.match(f.logs.find(([, title]) => title === 'RUN-END')[2], /获得积分=unknown/)
    assert.deepEqual(f.exitCodes, [1])
})

test('a worker that vanished without account statistics cannot make the master publish known successful totals', t => {
    const f = taskFixture(t)
    assert.equal(f.bot.reportRunEnd([], Date.now(), true, 2), true)
    assert.match(f.logs[0][2], /获得积分=unknown/)
    assert.match(f.logs[0][2], /失败账户数=2$/)
})

test('all successful accounts still exit zero and publish a complete run result', async t => {
    const f = taskFixture(t, { fail: false })
    await f.bot.runTasks(f.accounts, Date.now())
    assert.deepEqual(f.exitCodes, [0])
    assert.equal(f.logs.filter(([, title]) => title === 'ACCOUNT-ERROR').length, 0)
    assert.match(f.logs.find(([, title]) => title === 'RUN-END')[2], /失败账户数=0$/)
})

test('read debug, per-article confirmation and aggregate summary credit the same 31 points once', () => {
    const state = createRunState()
    apply(state, 'first', 'ACCOUNT-START', '开始处理账户: First@Test.invalid | geoLocale: CN | locale: zh-CN')
    apply(state, 'first', 'URL-REWARD', 'UrlReward 完成 | pointsGained=136 | currentBalance=12953')
    apply(state, 'first', 'DAILY-CHECK-IN', '每日签到完成 | pointsGained=5 | currentBalance=12958')
    let balance = 12958
    for (let index = 1; index <= 10; index++) {
        const gain = index === 8 ? 4 : 3
        balance += gain
        apply(
            state,
            'first',
            'READ-TO-EARN',
            `文章后的积分变化 | pointsGained=${gain} | currentBalance=${balance}`,
            'DEBUG'
        )
        const confirmation = `已阅读第 ${index}/10 篇文章 | status=200 | pointsGained=${gain} | currentBalance=${balance}`
        apply(state, 'first', 'READ-TO-EARN', confirmation)
        if (index === 5) apply(state, 'first', 'READ-TO-EARN', confirmation)
    }
    apply(state, 'first', 'READ-TO-EARN', '读文赚积分完成 | pointsGained=31 | currentBalance=12989')
    apply(state, 'first', 'READ-TO-EARN', '读文赚积分完成 | pointsGained=31 | currentBalance=12989')
    const account = summarizeRunState(state).accounts[0]
    assert.equal(account.live.bySource.read, 31)
    assert.equal(account.live.gained, 172)
    assert.equal(account.live.balance, 12989)
})

test('read summary before delayed confirmations is idempotent and isolated between accounts', () => {
    const state = createRunState()
    for (const name of ['first', 'second']) {
        apply(state, name, 'ACCOUNT-START', `开始处理账户: ${name}@test.invalid | geoLocale: CN | locale: zh-CN`)
        apply(state, name, 'READ-TO-EARN', '读文赚积分完成 | pointsGained=6 | currentBalance=106')
    }
    for (let index = 1; index <= 2; index++) {
        apply(
            state,
            'first',
            'READ-TO-EARN',
            `已阅读第 ${index}/10 篇文章 | pointsGained=3 | currentBalance=${100 + index * 3}`
        )
    }
    assert.deepEqual(
        summarizeRunState(state).accounts.map(a => a.live.gained),
        [6, 6]
    )
})

test('an explicitly skipped account is terminal but never eligible for automatic retry', () => {
    const state = createRunState()
    apply(state, 'first', 'ACCOUNT-START', '开始处理账户: First@Test.invalid | geoLocale: CN | locale: zh-CN')
    apply(
        state,
        'first',
        'ACCOUNT-SKIP',
        '跳过账户: First@Test.invalid | 原因=Fraud_UserWarning_BotScore_UX | 持续秒数=0',
        'WARN'
    )
    const account = summarizeRunState(state).accounts[0]
    assert.equal(account.success, false)
    assert.equal(account.retryable, false)
})

test('failed account metadata overrides an old inflated counter, while unknown and real zero stay distinct', () => {
    for (const points of ['172', 'unknown', '0']) {
        const state = createRunState()
        apply(state, 'first', 'ACCOUNT-START', '开始处理账户: First@Test.invalid | geoLocale: CN | locale: zh-CN')
        apply(
            state,
            'first',
            'ACCOUNT-ERROR',
            `First@Test.invalid | 错误=desktop timeout | 已确认积分=${points} | 原余额=${points === 'unknown' ? 'unknown' : '0'} | 现余额=${points} | 持续秒数=2250.2`,
            'ERROR'
        )
        apply(
            state,
            'first',
            'RUN-END',
            `本轮存在未完成账户 | 处理账户数=1 | 获得积分=${points} | 原余额=${points === 'unknown' ? 'unknown' : '0'} | 现余额=${points} | 运行分钟数=37.5 | 失败账户数=1`
        )
        const result = summarizeRunState(state)
        assert.equal(result.accounts[0].success, false)
        assert.equal(result.accounts[0].error, 'desktop timeout')
        assert.equal(result.accounts[0].collectedPoints, points === 'unknown' ? null : Number(points))
        assert.equal(result.collected, points === 'unknown' ? null : Number(points))
        assert.equal(result.totals.accountsFailed, 1)
    }
})
