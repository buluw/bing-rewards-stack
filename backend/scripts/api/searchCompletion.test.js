import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { applyLogToRunState, createRunState, parseLogLine, summarizeRunState } from './logParser.js'

const require = createRequire(import.meta.url)
const { Search } = require('../../dist/functions/activities/search/BrowserSearch.js')
const { SearchManager } = require('../../dist/functions/activities/search/SearchManager.js')
const { SearchProgress } = require('../../dist/functions/activities/search/SearchProgress.js')
const { SearchQueryQueue } = require('../../dist/functions/SearchQueryQueue.js')
const { MicrosoftRewardsBot } = require('../../dist/index.js')
const humanize = require('../../dist/util/Humanize.js')
const timeout = () => new Error('Request timeout (20000 ms) exceeded.')

function fixture(t, options = {}) {
    let clock = 0
    let earned = options.earned ?? 0
    const maximum = options.maximum ?? 60
    const initialEarned = earned
    const searches = []
    const reads = []
    const waits = []
    const logs = []
    const attempts = new Map()
    const bot = {
        isMobile: false,
        config: {
            clusters: 1,
            workers: { doDesktopSearch: true, doMobileSearch: false },
            searchSettings: { runOnZeroPoints: options.runOnZeroPoints ?? false, clusterSearch: false }
        },
        userData: { initialPoints: 1000, currentPoints: 1000, gainedPoints: 0, userName: 'fixture' },
        utils: {
            wait: async delay => {
                waits.push(delay)
                clock += delay
                options.onWait?.({ delay, credit, clock })
            },
            getEmailUsername: email => email.split('@')[0]
        },
        logger: Object.fromEntries(
            ['info', 'warn', 'error', 'debug'].map(level => [
                level,
                (mobile, tag, message) => logs.push({ level, mobile, tag, message, user: bot.userData.userName })
            ])
        ),
        browser: {
            func: {
                synchronizeActiveBrowserCookies: async () => {},
                getDashboardData: async () => {
                    const count = searches.length
                    const attempt = (attempts.get(count) ?? 0) + 1
                    attempts.set(count, attempt)
                    reads.push({ searches: count, attempt, clock })
                    const override = options.read?.({ searches: count, attempt, clock, credit })
                    if (override !== undefined) return override
                    return dashboard()
                }
            },
            utils: { tryDismissAllMessages: async () => {} }
        }
    }
    function credit(points) {
        earned = Math.min(maximum, earned + points)
    }
    function dashboard() {
        return {
            dashboard: {
                userStatus: {
                    availablePoints: 1000 + earned - initialEarned,
                    counters: {
                        pcSearch: [{ pointProgress: earned, pointProgressMax: maximum }],
                        mobileSearch: [],
                        activityAndQuiz: [],
                        dailyPoint: []
                    }
                }
            }
        }
    }
    const page = {
        goto: async () => {},
        waitForLoadState: async () => {}
    }
    bot.mainDesktopPage = page
    bot.mainMobilePage = page
    bot.activities = { doSearch: (_page, mobile) => new Search(bot).doSearch(page, mobile) }
    t.mock.method(Search.prototype, 'bingSearch', async () => {
        searches.push({ clock })
        if (options.onSearch) options.onSearch({ searches: searches.length, credit, clock })
        else credit(3)
    })
    t.mock.method(SearchQueryQueue.prototype, 'prepare', async () => options.topics ?? 1)
    t.mock.method(SearchQueryQueue.prototype, 'next', async () =>
        searches.length < (options.queryLimit ?? Infinity) ? 'offline query' : null
    )
    t.mock.method(humanize, 'getSearchTargetRatio', () => options.targetRatio ?? 1)
    return { bot, page, searches, reads, waits, logs, task: new Search(bot), credit }
}

test('normal browser search confirms all 60 points and never performs a redundant final read', async t => {
    const f = fixture(t)
    assert.equal(await f.task.doSearch(f.page, false), 60)
    assert.equal(f.searches.length, 20)
    assert.equal(f.reads.length, 21)
    assert.equal(f.bot.userData.currentPoints, 1060)
    assert.deepEqual(f.waits, [])
    assert.ok(f.logs.some(row => row.message.includes('必应搜索完成')))
})

test('a rerun starting at 42/60 only searches for the missing 18 points', async t => {
    const f = fixture(t, { earned: 42 })
    assert.equal(await f.task.doSearch(f.page, false), 18)
    assert.equal(f.searches.length, 6)
    assert.equal(f.bot.userData.currentPoints, 1018)
    assert.equal(f.bot.userData.gainedPoints, 18)
})

test('already completed quota is a genuine zero-gain success with no searches', async t => {
    const f = fixture(t, { earned: 60 })
    assert.equal(await f.task.doSearch(f.page, false), 0)
    assert.equal(f.searches.length, 0)
    assert.equal(f.reads.length, 1)
})

test('one or two quota timeouts after search 14 retry only the read, not the search', async t => {
    for (const failures of [1, 2]) {
        const f = fixture(t, {
            read: ({ searches, attempt }) => {
                if (searches === 14 && attempt <= failures) throw timeout()
            }
        })
        assert.equal(await f.task.doSearch(f.page, false), 60)
        assert.equal(f.searches.length, 20)
        assert.deepEqual(f.waits, failures === 1 ? [3000] : [3000, 5000])
        assert.equal(f.reads.filter(row => row.searches === 14).length, failures + 1)
        assert.equal(f.bot.userData.gainedPoints, 60)
    }
})

test('persistent quota timeout keeps confirmed 39 points and never reports success or sends search 15', async t => {
    const f = fixture(t, {
        read: ({ searches }) => {
            if (searches === 14) throw timeout()
        }
    })
    await assert.rejects(f.task.doSearch(f.page, false), /timeout/)
    assert.equal(f.searches.length, 14)
    assert.equal(f.reads.filter(row => row.searches === 14).length, 3)
    assert.deepEqual(f.waits, [3000, 5000])
    assert.equal(f.bot.userData.currentPoints, 1039)
    assert.equal(f.bot.userData.gainedPoints, 39)
    assert.ok(f.logs.some(row => row.message.includes('必应搜索未完成')))
    assert.ok(!f.logs.some(row => row.message.includes('必应搜索完成')))
})

test('quota retry reconciles delayed credit once and never credits the same gain twice', async t => {
    const f = fixture(t, {
        maximum: 3,
        onSearch: () => {},
        read: ({ searches, attempt }) => {
            if (searches === 1 && attempt === 1) throw timeout()
        },
        onWait: ({ credit }) => credit(3)
    })
    assert.equal(await f.task.doSearch(f.page, false), 3)
    assert.equal(f.searches.length, 1)
    assert.equal(f.bot.userData.gainedPoints, 3)
})

test('ten stagnant searches receive bounded final read-only reconciliation and remain incomplete', async t => {
    const f = fixture(t, {
        onSearch: ({ searches, credit }) => {
            if (searches <= 14) credit(3)
        }
    })
    await assert.rejects(f.task.doSearch(f.page, false), /搜索未完成（连续搜索未获得积分）.*remaining=18/)
    assert.equal(f.searches.length, 24)
    assert.equal(f.reads.filter(row => row.searches === 24).length, 3)
    assert.deepEqual(f.waits, [3000, 5000])
    assert.equal(f.bot.userData.gainedPoints, 42)
})

test('late final credit can complete the quota during polling without another search', async t => {
    const f = fixture(t, {
        maximum: 3,
        onSearch: () => {},
        onWait: ({ credit }) => credit(3)
    })
    assert.equal(await f.task.doSearch(f.page, false), 3)
    assert.equal(f.searches.length, 10)
    assert.deepEqual(f.waits, [3000])
    assert.equal(f.bot.userData.gainedPoints, 3)
})

test('late partial credit is retained in both the account balance and the search source, without duplicate gains', async t => {
    let settled = false
    const f = fixture(t, {
        onSearch: ({ searches, credit }) => {
            if (searches <= 14) credit(3)
        },
        onWait: ({ credit }) => {
            if (!settled) credit(3)
            settled = true
        }
    })
    await assert.rejects(f.task.doSearch(f.page, false), /remaining=15/)
    assert.equal(f.searches.length, 24)
    assert.equal(f.bot.userData.gainedPoints, 45)
    const state = createRunState()
    applyLogToRunState(
        state,
        parseLogLine(
            '[11/23/2026, 9:00:00 AM] [fixture] [INFO] MAIN [ACCOUNT-START] 开始处理账户: fixture@test.invalid | geoLocale: CN | locale: zh-CN'
        )
    )
    for (const row of f.logs) {
        applyLogToRunState(
            state,
            parseLogLine(
                `[11/23/2026, 9:00:00 AM] [fixture] [${row.level.toUpperCase()}] DESKTOP [${row.tag}] ${row.message}`
            )
        )
    }
    const account = summarizeRunState(state).accounts[0]
    assert.equal(account.live.gained, 45)
    assert.equal(account.live.bySource.search, 45)
    assert.equal(account.live.balance, 1045)
})

test('exhausted or empty query sources never turn missing quota into success', async t => {
    for (const options of [{ queryLimit: 2 }, { topics: 0 }]) {
        const f = fixture(t, options)
        await assert.rejects(f.task.doSearch(f.page, false), /搜索未完成（可用查询已耗尽）/)
        assert.equal(f.searches.length, options.queryLimit ?? 0)
        assert.deepEqual(f.waits, [3000, 5000])
    }
})

test('the existing 100-search bound is preserved and an unfilled quota is reported incomplete', async t => {
    const f = fixture(t, {
        maximum: 600,
        onSearch: ({ searches, credit }) => {
            if (searches % 2 === 0) credit(3)
        }
    })
    await assert.rejects(f.task.doSearch(f.page, false), /达到搜索次数上限/)
    assert.equal(f.searches.length, 100)
    assert.equal(f.bot.userData.gainedPoints, 150)
})

test('explicit humanized targets and runOnZeroPoints retain their configured semantics', async t => {
    const target = fixture(t, { targetRatio: 0.7 })
    assert.equal(await target.task.doSearch(target.page, false), 42)
    assert.equal(target.searches.length, 14)
    const zero = fixture(t, { maximum: 0, runOnZeroPoints: true })
    assert.equal(await zero.task.doSearch(zero.page, false), 0)
    assert.equal(zero.searches.length, 10)
})

test('missing or malformed quota data is an error, never an implicit completed zero quota', async t => {
    for (const value of [undefined, null, NaN, Infinity, '', -1]) {
        const f = fixture(t, {
            read: () => ({
                dashboard: {
                    userStatus: {
                        counters: { pcSearch: [{ pointProgress: value, pointProgressMax: 60 }], mobileSearch: [] }
                    }
                }
            })
        })
        await assert.rejects(f.task.doSearch(f.page, false), /搜索配额数值无效/)
        assert.equal(f.searches.length, 0)
        assert.deepEqual(f.waits, [])
    }
    const f = fixture(t, { read: () => ({ dashboard: { userStatus: {} } }) })
    await assert.rejects(f.task.doSearch(f.page, false), /搜索配额数据缺失/)
    assert.equal(f.searches.length, 0)
})

test('disappearing or changed quota ceilings cannot manufacture completion or points', async t => {
    for (const pcSearch of [[], [{ pointProgress: 3, pointProgressMax: 90 }]]) {
        const f = fixture(t, {
            read: ({ searches }) => {
                if (searches) return { dashboard: { userStatus: { counters: { pcSearch, mobileSearch: [] } } } }
            }
        })
        await assert.rejects(f.task.doSearch(f.page, false), /配额上限发生变化/)
        assert.equal(f.searches.length, 1)
        assert.equal(f.bot.userData.gainedPoints, 0)
        assert.deepEqual(f.waits, [])
    }
})

test('401 and 403 do not receive transient retries or more searches', async t => {
    for (const status of [401, 403]) {
        const f = fixture(t, {
            read: ({ searches }) => {
                if (searches) throw Object.assign(new Error('Request failed with status code ' + status), { status })
            }
        })
        await assert.rejects(f.task.doSearch(f.page, false), new RegExp(String(status)))
        assert.equal(f.searches.length, 1)
        assert.deepEqual(f.waits, [])
    }
})

test('a transient startup read can recover without sending a premature search', async t => {
    const f = fixture(t, {
        read: ({ searches, attempt }) => {
            if (searches === 0 && attempt === 1) throw Object.assign(new Error('upstream unavailable'), { status: 503 })
        }
    })
    assert.equal(await f.task.doSearch(f.page, false), 60)
    assert.deepEqual(
        f.reads.slice(0, 2).map(row => row.searches),
        [0, 0]
    )
    assert.deepEqual(f.waits, [3000])
})

test('numeric quota strings and absent mobile eligibility remain supported', async t => {
    const f = fixture(t, {
        read: () => ({
            dashboard: {
                userStatus: {
                    counters: { pcSearch: [{ pointProgress: '60', pointProgressMax: '60' }], mobileSearch: [] }
                }
            }
        })
    })
    assert.equal(await f.task.doSearch(f.page, false), 0)
    assert.equal(f.searches.length, 0)
    assert.equal((await new SearchProgress(f.bot).getMissing(true)).totalPoints, 0)
})

test('SearchManager propagates an incomplete search instead of replacing it with zero', async t => {
    const f = fixture(t, { topics: 0 })
    await assert.rejects(new SearchManager(f.bot).searchDesktop({ email: 'fixture@test.invalid' }), /搜索未完成/)
    assert.ok(f.logs.some(row => row.tag === 'SEARCH-MANAGER' && row.message.includes('搜索失败')))
})

test('real search failure reaches ACCOUNT-ERROR, keeps the other account successful and exits nonzero', async t => {
    const f = fixture(t, {
        read: ({ searches }) => {
            if (searches === 14) throw timeout()
        }
    })
    Object.setPrototypeOf(f.bot, MicrosoftRewardsBot.prototype)
    f.bot.waitBeforeNextAccount = async () => {}
    f.bot.sendPushPlusSummary = async () => {}
    f.bot.sendServerChanSummary = async () => {}
    f.bot.sendClawBotSummary = async () => {}
    f.bot.Main = async account => {
        if (account.email.startsWith('first')) return { initialPoints: 2000, collectedPoints: 60 }
        f.bot.accountPointsReady = true
        f.bot.userData.initialPoints = 1000
        f.bot.userData.currentPoints = 1000
        const points = await new SearchManager(f.bot).searchDesktop(account)
        return { initialPoints: 1000, collectedPoints: points }
    }
    const exitCodes = []
    t.mock.method(process, 'exit', code => exitCodes.push(code))
    t.mock.method(humanize, 'markRunSucceeded', () => assert.fail('partial runs cannot be marked successful'))
    const accounts = ['first@test.invalid', 'second@test.invalid'].map(email => ({ email, geoLocale: 'CN', proxy: {} }))
    await f.bot.runTasks(accounts, Date.now())
    assert.deepEqual(exitCodes, [1])
    const state = createRunState()
    for (const row of f.logs) {
        const entry = parseLogLine(
            `[11/23/2026, 9:00:00 AM] [${row.user}] [${row.level.toUpperCase()}] MAIN [${row.tag}] ${row.message}`
        )
        applyLogToRunState(state, entry)
    }
    const result = summarizeRunState(state)
    assert.equal(result.accounts[0].success, true)
    assert.equal(result.accounts[0].collectedPoints, 60)
    assert.equal(result.accounts[1].success, false)
    assert.equal(result.accounts[1].collectedPoints, 39)
    assert.equal(result.accounts[1].live.bySource.search, 39)
    assert.equal(result.collected, 99)
    assert.equal(result.totals.accountsFailed, 1)
    assert.equal(f.logs.filter(row => row.tag === 'ACCOUNT-END').length, 1)
    assert.equal(f.logs.filter(row => row.tag === 'ACCOUNT-ERROR').length, 1)
})
