import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { applyLogToRunState, createRunState } from './logParser.js'

const require = createRequire(import.meta.url)
const { EdgeBrowsing } = require('../../dist/functions/activities/experimental/EdgeBrowsing.js')
const ReactFunc = require('../../dist/browser/ReactFunc.js').default
const { EdgeBrowsingProgress } = require('../../dist/functions/activities/experimental/EdgeBrowsingProgress.js')
const { URLs } = require('../../dist/constants/urls.js')

const acknowledgement = () => ({
    code: 0,
    response: { activity: { type: 29, q: 1, a: { offerid: 'DailyCheckIn_Edge' } }, isDuplicate: false }
})
const settings = { offerId: 'DailyCheckIn_Edge', activityType: '29', reportIntervalMinutes: 5 }
const flight = value =>
    '<script>self.__next_f.push([1,' + JSON.stringify('1:' + JSON.stringify(value) + '\n') + '])</script>'

function fixture(options = {}) {
    let clock = Date.parse(options.start ?? '2026-10-11T01:00:00Z')
    let minutes = options.minutes ?? 0
    const posts = []
    const waits = []
    const messages = []
    const reads = []
    const pendingCredits = []
    const settleCredits = () => {
        for (let index = pendingCredits.length - 1; index >= 0; index--) {
            if (pendingCredits[index].at > clock) continue
            minutes = Math.min(30, minutes + pendingCredits[index].minutes)
            pendingCredits.splice(index, 1)
        }
    }
    const bot = {
        accessToken: 'offline-fixture',
        isMobile: true,
        currentAccountEmail: 'fixture@example.com',
        accountLocale: { acceptLanguage: 'zh-CN', locale: 'zh-CN' },
        userData: { geoLocale: 'CN', timezoneOffset: '-480', currentPoints: 973 },
        cookies: { mobile: [], desktop: [] },
        reactSnapshot: null,
        reactSnapshots: { mobile: null, desktop: null },
        utils: { randomDelay: () => 5000 },
        logger: Object.fromEntries(
            ['debug', 'info', 'warn', 'error'].map(level => [
                level,
                (_mobile, tag, message) => messages.push({ level, tag, message })
            ])
        ),
        browser: { func: {} },
        http: {
            async request(config) {
                settleCredits()
                if (config.url === URLs.platform.edgeProfile) {
                    if (options.profileErrorAfter != null && posts.length >= options.profileErrorAfter)
                        throw new Error('offline profile unavailable')
                    return {
                        status: 200,
                        data: {
                            code: 0,
                            response: {
                                promotions: [
                                    {
                                        name: 'edge_browsing_streak_flight',
                                        attributes: {
                                            offerid: settings.offerId,
                                            report_offer_type: settings.activityType,
                                            report_per_minutes: '5',
                                            complete: String(
                                                options.profileComplete ?? (minutes >= 30 && options.complete !== false)
                                            )
                                        }
                                    }
                                ]
                            }
                        }
                    }
                }
                assert.equal(config.url, URLs.platform.activities, 'unexpected network request')
                assert.equal(config.method, 'POST')
                const action = options.reports?.[posts.length] ?? {}
                posts.push({ at: clock, retries: config.retries })
                pendingCredits.push({
                    at: clock + (action.creditDelayMs ?? options.creditDelayMs ?? 0),
                    minutes: action.effect ?? 5
                })
                settleCredits()
                clock += action.advanceMs ?? 0
                if (action.error) throw action.error
                return { status: 200, data: action.data ?? acknowledgement() }
            }
        }
    }
    bot.browser.react = new ReactFunc(bot)
    bot.browser.func.getRewardsPageHtml = async (url, route) => {
        settleCredits()
        reads.push({ at: clock, url, route, posts: posts.length })
        const value = {
            partner: 'edge',
            activitiesCompleted: minutes,
            activitiesTotal: 30,
            isCurrentDayCompleted: minutes >= 30 && options.complete !== false,
            isEnabled: true,
            currentDay: 4,
            dailyPoints: [5, 10, 20, 30, 40, 80, 120]
        }
        return options.read ? options.read({ value, reads, posts, clock }) : flight(value)
    }
    const task = new EdgeBrowsing(bot, () => clock)
    task.wait = async (delay, signal) => {
        if (signal?.aborted) return false
        waits.push(delay)
        clock += delay
        clock += options.onWait?.({ delay, posts, clock }) ?? 0
        return !signal?.aborted
    }
    return { bot, task, posts, waits, messages, reads, minutes: () => minutes }
}

test('missing activity receipt is uncertain, not accepted; report POST disables automatic retries', async () => {
    const f = fixture({ reports: [{ effect: 0, data: { code: 0, response: {} } }] })
    const result = await f.task.submitReport('offline-fixture', settings)
    assert.equal(result.outcome, 'uncertain')
    assert.equal(f.posts[0].retries, 0)
})

function parsedState(f) {
    const state = createRunState()
    const entry = (title, message, user = 'fixture') => ({
        title,
        message,
        user,
        parsed: true,
        receivedAt: '2026-10-11T01:00:00Z'
    })
    applyLogToRunState(
        state,
        entry('ACCOUNT-START', '开始处理账户: fixture@example.com | geoLocale: CN | locale: zh-CN')
    )
    applyLogToRunState(state, entry('SEARCH-BING', '开始必应搜索 | 当前余额=973'))
    applyLogToRunState(
        state,
        entry('ACCOUNT-START', '开始处理账户: second@example.com | geoLocale: CN | locale: zh-CN', 'second')
    )
    applyLogToRunState(state, entry('SEARCH-BING', '开始必应搜索 | 当前余额=500', 'second'))
    for (const log of f.messages) applyLogToRunState(state, { ...entry(log.tag, log.message), level: log.level })
    assert.equal(state.accounts['fixture@example.com'].live.balance, 973)
    assert.equal(state.accounts['second@example.com'].live.balance, 500)
    assert.equal(state.accounts['second@example.com'].edgeBrowsing, null)
    return state.accounts['fixture@example.com'].edgeBrowsing
}

test('resuming 25/30 records one attempt and six official intervals, without restarting from zero', async () => {
    const f = fixture({ minutes: 25 })
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 1)
    const state = parsedState(f)
    assert.equal(state.status, 'complete')
    assert.equal(state.attemptedReports, 1)
    assert.equal(state.reportsCompleted, 6)
    assert.equal(state.reportsRemaining, 0)
    assert.equal(state.officialMinutes, 30)
})

test('unknown initial official progress stops without POST or fabricated zero/complete', async () => {
    const f = fixture({ read: () => null })
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 0)
    const state = parsedState(f)
    assert.equal(state.status, 'partial')
    assert.equal(state.progressKnown, false)
    assert.equal(state.officialMinutes, null)
    assert.equal(state.scheduledMinutesCovered, null)
    assert.equal(state.reportsCompleted, null)
    assert.equal(state.reportsRemaining, null)
    assert.equal(state.estimatedRemainingMinutes, null)
})

test('a lost progress read after a report preserves the last confirmed 25, not 0 or 30', async () => {
    const f = fixture({
        minutes: 25,
        profileComplete: false,
        read: ({ value, posts }) => (posts.length ? null : flight(value))
    })
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 1)
    const state = parsedState(f)
    assert.equal(state.status, 'partial')
    assert.equal(state.progressKnown, false)
    assert.equal(state.officialMinutes, 25)
    assert.equal(state.reportsRemaining, 1)
    assert.equal(state.nextReportInSeconds, null)
    assert.equal(state.estimatedRemainingMinutes, null)
})

test('a delayed credit is detected with read-only polls at 0 and 15 seconds, without an extra POST', async () => {
    const f = fixture({
        minutes: 25,
        profileComplete: false,
        read: ({ value, reads, posts }) => {
            if (posts.length && reads.filter(x => x.posts === 1).length === 1)
                return flight({ ...value, activitiesCompleted: 25, isCurrentDayCompleted: false })
            return flight(value)
        }
    })
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 1)
    assert.deepEqual(f.waits, [305000, 15000])
    assert.equal(parsedState(f).status, 'complete')
})

test('reports credited after 120 seconds reset the streak at the next pre-report read and finish 30/30', async () => {
    const f = fixture({ creditDelayMs: 120000 })
    await f.task.run({ dashboard: {} })
    const state = parsedState(f)
    assert.equal(state.status, 'complete')
    assert.equal(state.stopReason, 'complete')
    assert.equal(state.officialMinutes, 30)
    assert.equal(state.reportsRemaining, 0)
    assert.equal(f.posts.length, 6, 'delayed credit must not cause an extra POST')
    assert.ok(f.reads.some(read => read.posts === 1 && read.at - f.posts[0].at === 60000))
    for (let index = 1; index < f.posts.length; index++) assert.ok(f.posts[index].at - f.posts[index - 1].at >= 300000)
    assert.ok(!f.messages.some(log => log.message.includes('stopReason=no-progress')))
})

test('one late credit resets the streak, but three subsequent truly stalled reports still stop', async () => {
    const f = fixture({
        creditDelayMs: 120000,
        reports: [{}, { effect: 0 }, { effect: 0 }, { effect: 0 }]
    })
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 4)
    const state = parsedState(f)
    assert.equal(state.status, 'partial')
    assert.equal(state.stopReason, 'no-progress')
    assert.equal(state.officialMinutes, 5)
    assert.equal(state.reportsRemaining, 5)
})

test('official progress which arrives during the next interval prevents an unnecessary POST', async () => {
    const f = fixture({
        minutes: 25,
        read: ({ value, reads }) =>
            flight(reads.length > 1 ? { ...value, activitiesCompleted: 30, isCurrentDayCompleted: true } : value)
    })
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 0)
    assert.equal(parsedState(f).status, 'complete')
})

test('duplicate and uncertain receipts never count as accepted; repeated no-progress stops', async () => {
    const duplicate = { code: 0, response: { isDuplicate: true } }
    const f = fixture({
        reports: [
            { effect: 0, data: duplicate },
            { effect: 0, data: { code: 0, response: {} } },
            { effect: 0, data: duplicate }
        ]
    })
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 3)
    const state = parsedState(f)
    assert.equal(state.accepted, 0)
    assert.equal(state.uncertain, 1)
    assert.equal(state.duplicates, 2)
    assert.equal(state.officialMinutes, 0)
    assert.equal(state.reportsRemaining, 6)
    assert.equal(state.stopReason, 'no-progress')
    assert.equal(state.status, 'partial')
})

test('valid receipts alone do not manufacture credited minutes', async () => {
    const f = fixture({ reports: [{ effect: 0 }, { effect: 0 }, { effect: 0 }] })
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 3)
    const state = parsedState(f)
    assert.equal(state.accepted, 3)
    assert.equal(state.officialMinutes, 0)
    assert.equal(state.reportsRemaining, 6)
    assert.equal(state.status, 'partial')
})

test('extra attempts are capped at two even with intermittent progress', async () => {
    const f = fixture({ reports: [{}, { effect: 0 }, {}, { effect: 0 }, {}, { effect: 0 }, {}, {}] })
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 8)
    const state = parsedState(f)
    assert.equal(state.officialMinutes, 25)
    assert.equal(state.reportsRemaining, 1)
    assert.equal(state.stopReason, 'attempt-limit')
    assert.equal(state.status, 'partial')
})

test('a 401 is not retried, does not clear points, and stops further reports', async () => {
    const f = fixture({
        minutes: 25,
        reports: [{ effect: 0, error: Object.assign(new Error('fixture secret'), { status: 401 }) }]
    })
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 1)
    assert.equal(f.posts[0].retries, 0)
    assert.equal(parsedState(f).stopReason, 'authorization-failed')
    assert.ok(!f.messages.some(x => x.message.includes('fixture secret')))
})

test('timeout with a credited report is reconciled as complete, without resubmission', async () => {
    const f = fixture({ minutes: 25, reports: [{ error: new Error('offline timeout') }] })
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 1)
    assert.equal(parsedState(f).status, 'complete')
    assert.equal(parsedState(f).accepted, 0)
    assert.equal(parsedState(f).failed, 1)
})

test('timeout without credit waits the full report interval before a bounded new attempt', async () => {
    const f = fixture({ minutes: 25, reports: [{ effect: 0, error: new Error('offline timeout') }] })
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 2)
    assert.ok(f.posts[1].at - f.posts[0].at >= 300000)
    assert.equal(parsedState(f).status, 'complete')
})

test('30 minutes without an official completion flag is read-only and remains unconfirmed', async () => {
    const f = fixture({ minutes: 30, complete: false })
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 0)
    assert.equal(parsedState(f).status, 'partial')
    assert.equal(parsedState(f).stopReason, 'completion-unconfirmed')
})

test('disabled or regressed official activity never authorizes a report', async () => {
    for (const mode of ['disabled', 'regressed']) {
        const f = fixture({
            minutes: 25,
            read: ({ value, reads }) =>
                flight({
                    ...value,
                    isEnabled: mode !== 'disabled',
                    activitiesCompleted: mode === 'regressed' && reads.length > 1 ? 0 : 25
                })
        })
        await f.task.run({ dashboard: {} })
        assert.equal(f.posts.length, 0)
        assert.equal(parsedState(f).stopReason, mode === 'disabled' ? 'disabled' : 'progress-regressed')
    }
})

test('cancellation during interval or confirmation prevents any later POST', async () => {
    for (const phase of ['interval', 'confirmation']) {
        const controller = new AbortController()
        const f = fixture({
            reports: [{ effect: 0 }],
            onWait: ({ delay }) => {
                if ((phase === 'interval' && delay > 300000) || (phase === 'confirmation' && delay === 15000))
                    controller.abort()
            }
        })
        await f.task.run({ dashboard: {} }, controller.signal)
        assert.equal(f.posts.length, phase === 'interval' ? 0 : 1)
        assert.equal(parsedState(f).status, 'cancelled')
    }
})

test('crossing the account-local date boundary before or during POST never confirms yesterday', async () => {
    const before = fixture({ minutes: 25, start: '2026-10-11T15:57:00Z' })
    await before.task.run({ dashboard: {} })
    assert.equal(before.posts.length, 0)
    assert.equal(parsedState(before).stopReason, 'day-changed')
    const during = fixture({ minutes: 25, reports: [{ advanceMs: 24 * 60 * 60000 }] })
    await during.task.run({ dashboard: {} })
    assert.equal(during.posts.length, 1)
    assert.equal(parsedState(during).status, 'partial')
    assert.equal(parsedState(during).stopReason, 'day-changed')
})

test('a changed official streak day also stops, even before local midnight', async () => {
    const f = fixture({
        minutes: 25,
        read: ({ value, reads }) => flight({ ...value, currentDay: reads.length > 1 ? 5 : 4 })
    })
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 0)
    assert.equal(parsedState(f).stopReason, 'day-changed')
})

test('a long suspended interval respects the total runtime budget', async () => {
    const f = fixture({ onWait: () => 12 * 60000 })
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 2)
    assert.equal(parsedState(f).stopReason, 'time-limit')
})

test('missing or conflicting strict activity data is never borrowed from cached snapshots', async () => {
    const f = fixture({ read: ({ value }) => flight([value, { ...value, activitiesCompleted: 25 }]) })
    f.bot.reactSnapshot = { streaks: [{ partner: 'edge', activitiesCompleted: 0, activitiesTotal: 30 }] }
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 0)
    assert.equal(parsedState(f).progressKnown, false)
})

test('official completion can be confirmed by either fresh source without clearing shared snapshots', async () => {
    for (const source of ['page', 'profile']) {
        const f = fixture({
            minutes: 25,
            profileErrorAfter: source === 'page' ? 1 : undefined,
            read: ({ value, posts }) => (source === 'profile' && posts.length ? null : flight(value))
        })
        const cached = { offers: ['fixture'], streaks: [], account: { availablePoints: 973 } }
        f.bot.reactSnapshot = cached
        await f.task.run({ dashboard: {} })
        assert.equal(f.posts.length, 1)
        assert.equal(parsedState(f).status, 'complete')
        assert.equal(f.bot.reactSnapshot, cached)
    }
})

test('valid receipt accepts numeric strings but never treats an absent duplicate flag as false', async () => {
    const receipt = acknowledgement()
    receipt.response.activity.type = '29'
    receipt.response.activity.q = '1'
    const f = fixture({ reports: [{ data: receipt }] })
    assert.equal((await f.task.submitReport('offline-fixture', settings)).outcome, 'acknowledged')
    delete receipt.response.isDuplicate
    const missing = fixture({ reports: [{ data: receipt }] })
    assert.equal((await missing.task.submitReport('offline-fixture', settings)).outcome, 'uncertain')
})

test('mismatched offer/type/quantity and malformed duplicate flags are uncertain, never acknowledged', async () => {
    const cases = [
        { activity: { type: 29, q: 1, a: { offerid: 'another-offer' } }, isDuplicate: false },
        { activity: { type: 103, q: 1, a: { offerid: settings.offerId } }, isDuplicate: false },
        { activity: { type: 29, q: true, a: { offerid: settings.offerId } }, isDuplicate: false },
        { activity: { type: 29, q: 0, a: { offerid: settings.offerId } }, isDuplicate: false },
        { ...acknowledgement().response, isDuplicate: 'false' },
        null
    ]
    for (const response of cases) {
        const f = fixture({ reports: [{ data: { code: 0, response } }] })
        assert.equal((await f.task.submitReport('offline-fixture', settings)).outcome, 'uncertain')
    }
})

test('malformed completion flag remains unknown and fractional last interval cannot undercount completion', () => {
    const f = fixture()
    for (const value of [undefined, '', 0, 1, 'unknown', {}])
        assert.equal(f.task.promotionComplete({ attributes: { complete: value } }), null)
    assert.equal(f.task.promotionComplete({ attributes: { complete: true } }), true)
    const counter = new EdgeBrowsingProgress(30, 7, [420000], () => 0)
    const done = counter.snapshot(1, 30, true)
    assert.equal(done.reportsCompleted, 5)
    assert.equal(done.reportsRemaining, 0)
})

test('the real abortable wait exits promptly without waiting for a timer', async () => {
    const f = fixture()
    const controller = new AbortController()
    const waiting = EdgeBrowsing.prototype.wait.call(f.task, 300000, controller.signal)
    controller.abort()
    assert.equal(await waiting, false)
    assert.equal(await EdgeBrowsing.prototype.wait.call(f.task, 300000, controller.signal), false)
})

test('unsupported official target stops instead of guessing a report quota', async () => {
    const f = fixture({ read: ({ value }) => flight({ ...value, activitiesTotal: 60 }) })
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 0)
    assert.equal(parsedState(f).progressKnown, false)
})

test('normal run confirms six reports and preserves existing account balance', async () => {
    const f = fixture()
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 6)
    assert.equal(f.minutes(), 30)
    assert.ok(
        f.messages.some(
            x => x.message.startsWith('后台 Edge 浏览活动结束') && x.message.includes('serverComplete=true')
        )
    )
    assert.equal(f.bot.userData.currentPoints, 973)
})

test('second report with HTTP 200 but no receipt needs one bounded extra interval, not false 30/30', async () => {
    const f = fixture({ reports: [{}, { effect: 0, data: { code: 0, response: {} } }] })
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 7)
    assert.equal(f.minutes(), 30)
    const summary = f.messages.findLast(x => x.message.startsWith('后台 Edge 浏览活动结束')).message
    assert.match(summary, /accepted=6(?: \| |$)/)
    assert.match(summary, /uncertain=1(?: \| |$)/)
    assert.match(summary, /serverComplete=true/)
    for (let n = 1; n < f.posts.length; n++) assert.ok(f.posts[n].at - f.posts[n - 1].at >= 300000)
})

test('ambiguous receipt which actually advanced official progress is not submitted twice', async () => {
    const f = fixture({ minutes: 25, reports: [{ data: { code: 0, response: {} } }] })
    await f.task.run({ dashboard: {} })
    assert.equal(f.posts.length, 1)
    assert.equal(f.minutes(), 30)
})

test('strict progress parsing does not manufacture zero from missing or invalid fields', () => {
    const f = fixture()
    const valid = {
        partner: 'edge',
        activitiesCompleted: 25,
        activitiesTotal: 30,
        isCurrentDayCompleted: false,
        isEnabled: true,
        currentDay: 4,
        dailyPoints: [5, 10]
    }
    assert.equal(f.bot.browser.react.getEdgeBrowsingProgress(flight(valid)).minutes, 25)
    for (const field of ['activitiesCompleted', 'activitiesTotal', 'isCurrentDayCompleted', 'isEnabled']) {
        const value = { ...valid }
        delete value[field]
        assert.equal(f.bot.browser.react.getEdgeBrowsingProgress(flight(value)), null, field)
    }
    for (const value of [null, '', 'unknown', -1, 31, true]) {
        assert.equal(
            f.bot.browser.react.getEdgeBrowsingProgress(flight({ ...valid, activitiesCompleted: value })),
            null
        )
    }
})
