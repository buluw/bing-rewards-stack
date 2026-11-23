import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const ReactFunc = require('../../dist/browser/ReactFunc.js').default
const BrowserFunc = require('../../dist/browser/BrowserFunc.js').default
const { Login } = require('../../dist/browser/auth/Login.js')
const Utils = require('../../dist/util/Utils.js').default
const { DailySet } = require('../../dist/functions/activities/rewards/DailySet.js')
const { UrlReward } = require('../../dist/functions/activities/api/UrlReward.js')
const { DefaultSearchEngine } = require('../../dist/functions/activities/search/DefaultSearchEngine.js')
const { DefaultSearchState, defaultSearchDay } = require('../../dist/util/DefaultSearchState.js')
const { SearchQueryQueue } = require('../../dist/functions/SearchQueryQueue.js')
const { MicrosoftRewardsBot } = require('../../dist/index.js')
const logger = { info() {}, debug() {}, warn() {}, error() {} }
const parser = new ReactFunc({ logger, isMobile: false })
const progress = (days, extra = {}) => ({
    title: '默认搜索引擎',
    activity: 'dse',
    days,
    daysMax: 14,
    isCompleted: days === 14,
    isInProgress: days > 0,
    ...extra
})
function html(...cards) {
    const stream = cards.map((card, i) => `${i}:${JSON.stringify(card)}\n`).join('')
    return [stream.slice(0, 37), stream.slice(37)]
        .map(chunk => `<script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>`)
        .join('')
}
function temp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-dse-test-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

test('DSE parser uses complete card data, including a not-yet-started day zero', () => {
    const source = html({ activity: 'dse', description: 'metadata only' }, progress(0))
    assert.deepEqual(parser.getDefaultSearchProgress(source), { days: 0, daysMax: 14, isCompleted: false })
    assert.equal(parser.snapshotPage(source).defaultSearch.days, 0)
    assert.equal(parser.getDefaultSearchProgress(html(progress(14))).isCompleted, true)
})

test('DSE missing, invalid, locked and conflicting data stay unknown, never zero', () => {
    const invalid = [null, undefined, '', '1', -1, 15, 1.5]
    for (const days of invalid) assert.equal(parser.getDefaultSearchProgress(html(progress(days))), null)
    for (const extra of [{ daysMax: 30 }, { isCompleted: undefined }, { isLocked: true }, { isDisabled: true }]) {
        assert.equal(parser.getDefaultSearchProgress(html(progress(1, extra))), null)
    }
    assert.equal(parser.getDefaultSearchProgress('<html>Sign in</html>'), null)
    assert.equal(parser.getDefaultSearchProgress(html(progress(1), progress(2))), null)
})

test('daily reservation persists across instances and isolates accounts at the Beijing date boundary', t => {
    const dir = temp(t)
    const now = Date.parse('2026-10-07T15:59:59Z')
    assert.equal(defaultSearchDay(now), '2026-10-07')
    assert.equal(defaultSearchDay(now + 1000), '2026-10-08')
    const first = new DefaultSearchState(dir).reserve('A@test.invalid', 1, now)
    assert.ok(first)
    assert.equal(new DefaultSearchState(dir).reserve('a@test.invalid', 1, now), null)
    assert.ok(new DefaultSearchState(dir).reserve('b@test.invalid', 1, now))
    assert.ok(new DefaultSearchState(dir).reserve('a@test.invalid', 1, now + 1000))
    assert.ok(!fs.readdirSync(path.join(dir, 'default-search')).some(name => name.includes('@')))
})

function fixture(t, { results = [progress(1), progress(2)], now = Date.parse('2026-10-07T06:00:00Z') } = {}) {
    const dir = temp(t)
    const messages = []
    const searches = []
    const polls = []
    const waits = []
    let currentUrl = 'https://rewards.bing.com/earn'
    let clock = now
    const request = {
        get: async (url, options) => {
            assert.equal(url, 'https://rewards.bing.com/earn')
            assert.equal(options.maxRedirects, 0)
            polls.push(clock)
            const result = results[Math.min(polls.length - 1, results.length - 1)]
            return {
                status: () => (typeof result === 'number' ? result : 200),
                text: async () => (result ? html(result) : '<html>Sign in</html>'),
                dispose: async () => {}
            }
        }
    }
    const page = {
        context: () => ({ request }),
        url: () => currentUrl,
        goto: async url => {
            const parsed = new URL(url)
            assert.equal(parsed.searchParams.get('FORM'), 'CHROMN')
            assert.equal(parsed.searchParams.get('PC'), 'U316')
            assert.equal(parsed.searchParams.get('q'), '中文空格 & Chromium')
            searches.push(url)
            parsed.hostname = 'cn.bing.com'
            currentUrl = parsed.href
            return { ok: () => true }
        }
    }
    const bot = {
        currentAccountEmail: 'a@test.invalid',
        config: { sessionPath: dir, workers: { doDesktopSearch: true } },
        logger: Object.fromEntries(Object.keys(logger).map(key => [key, (...args) => messages.push(args.join(' '))])),
        userData: { currentPoints: 973 },
        utils: {
            wait: async ms => {
                waits.push(ms)
                clock += ms
            }
        },
        browser: {
            react: parser,
            func: {
                refreshEarnSnapshot: async () => ({ defaultSearch: parser.getDefaultSearchProgress(html(results[0])) }),
                synchronizeActiveBrowserCookies: async () => {}
            }
        }
    }
    t.mock.method(SearchQueryQueue.prototype, 'prepare', async () => 1)
    t.mock.method(SearchQueryQueue.prototype, 'next', async () => '中文空格 & Chromium')
    const task = new DefaultSearchEngine(bot, () => clock)
    const records = () =>
        fs
            .readdirSync(dir, { recursive: true })
            .filter(name => name.endsWith('.json'))
            .map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
    return { bot, task, page, searches, polls, waits, messages, records, clock: () => clock }
}

test('one search confirms official days immediately without changing the cached point balance', async t => {
    const f = fixture(t)
    assert.equal(await f.task.needsRun(), true)
    await f.task.run(f.page)
    assert.equal(f.searches.length, 1)
    assert.equal(f.polls.length, 2)
    assert.deepEqual(f.waits, [])
    assert.equal(f.records()[0].status, 'confirmed')
    assert.equal(f.records()[0].afterDays, 2)
    assert.equal(f.bot.userData.currentPoints, 973)
    const restarted = new DefaultSearchEngine(f.bot, f.clock)
    assert.equal(await restarted.needsRun(), false)
    await restarted.run(f.page)
    assert.equal(f.searches.length, 1)
})

test('no progress polls at 0/15/60/120 seconds and remains unconfirmed on rerun', async t => {
    const f = fixture(t, { results: [progress(1)] })
    await f.task.run(f.page)
    assert.deepEqual(f.waits, [15000, 45000, 60000])
    assert.deepEqual(
        f.polls.slice(1).map(time => time - f.polls[0]),
        [0, 15000, 60000, 120000]
    )
    assert.equal(f.searches.length, 1)
    assert.equal(f.records()[0].status, 'unconfirmed')
    await f.task.run(f.page)
    assert.equal(f.searches.length, 1)
})

test('delayed increase stops further polls as soon as official progress advances', async t => {
    const f = fixture(t, { results: [progress(1), progress(1), progress(2)] })
    await f.task.run(f.page)
    assert.deepEqual(f.waits, [15000])
    assert.equal(f.records()[0].status, 'confirmed')
})

test('HTTP 401 before navigation does not consume an attempt or overwrite points', async t => {
    const f = fixture(t, { results: [401] })
    await f.task.run(f.page)
    assert.equal(f.searches.length, 0)
    assert.deepEqual(f.records(), [])
    assert.equal(f.bot.userData.currentPoints, 973)
    assert.ok(f.messages.some(message => message.includes('HTTP 401')))
})

test('401, missing data or a reset after navigation cannot be recorded as success', async t => {
    for (const after of [401, null, progress(0)]) {
        const f = fixture(t, { results: [progress(1), after] })
        await f.task.run(f.page)
        assert.equal(f.searches.length, 1)
        assert.equal(f.records()[0].status, 'unconfirmed')
        assert.equal(f.bot.userData.currentPoints, 973)
    }
})

test('HTTP 200 without a matching Bing results page is not successful', async t => {
    const f = fixture(t)
    f.page.url = () => 'https://login.live.com/'
    await f.task.run(f.page)
    assert.equal(f.records()[0].status, 'unconfirmed')
    assert.equal(f.polls.length, 1)
})

test('disabled, missing and completed activities never navigate', async t => {
    for (const card of [null, progress(14)]) {
        const f = fixture(t, { results: [card] })
        assert.equal(await f.task.needsRun(), false)
        await f.task.run(f.page)
        assert.equal(f.searches.length, 0)
    }
    const f = fixture(t)
    f.bot.config.workers.doDesktopSearch = false
    assert.equal(await f.task.needsRun(), false)
    await f.task.run(f.page)
    assert.equal(f.polls.length, 0)
})

test('overlapping workers reserve only one search, and crossing midnight cannot confirm the old day', async t => {
    const f = fixture(t, { results: [progress(1), progress(1), progress(2)] })
    await Promise.all([f.task.run(f.page), new DefaultSearchEngine(f.bot, f.clock).run(f.page)])
    assert.equal(f.searches.length, 1)
    const crossing = fixture(t, { results: [progress(1)], now: Date.parse('2026-10-07T15:59:58Z') })
    await crossing.task.run(crossing.page)
    assert.equal(crossing.records()[0].status, 'unconfirmed')
    assert.equal(crossing.polls.length, 2)
})

function accountFixture({
    mode = 'api',
    needed = true,
    quota = true,
    prewarm = false,
    desktopFailure,
    transientFailures = 0,
    required = false
} = {}) {
    const bot = Object.create(MicrosoftRewardsBot.prototype)
    const account = { email: 'a@test.invalid', geoLocale: 'CN', langCode: 'zh-CN' }
    const events = []
    const desktopError = new Error('simulated desktop initialization failure')
    const api = mode === 'api' || mode === 'hybrid'
    const cookies = side => [{ name: 'fixture', value: side, domain: '.bing.com', path: '/' }]
    const failAt = stage => {
        if (!bot.isMobile && stage === 'login' && transientFailures > 0) {
            transientFailures--
            throw new Error('Timeout 20000ms exceeded while preparing desktop session')
        }
        if (!bot.isMobile && desktopFailure === stage) throw desktopError
    }
    Object.assign(bot, {
        logger,
        userData: {},
        accountLocale: {},
        nextActions: {},
        nextRouterStateTree: '',
        config: {
            prewarmDesktopLogin: prewarm,
            workers: {
                doDesktopSearch: true,
                doDailySet: true,
                doDailyCheckIn: true,
                doAppPromotions: true,
                doReadToEarn: true,
                doVisualSearch: required
            },
            experimental: { apiSearch: api, apiSearchOnBing: mode === 'api' },
            activities: { searchOnBing: true },
            searchSettings: { parallelSearching: mode === 'parallel' }
        },
        http: { setDefaultHeaders() {} },
        gapBetweenWorkers: async () => {},
        utils: { wait: async ms => events.push(`retry-wait:${ms}`) },
        browserFactory: {
            createBrowser: async () => {
                const side = bot.isMobile ? 'mobile' : 'desktop'
                events.push(`${side}-open`)
                failAt('launch')
                return {
                    fingerprint: { side },
                    context: {
                        side,
                        newPage: async () => {
                            failAt('page')
                            return { side }
                        },
                        cookies: async () => {
                            failAt('cookies')
                            return cookies(side)
                        }
                    }
                }
            },
            generateFingerprint: async isMobile => {
                assert.equal(isMobile, false)
                events.push('api-desktop-fingerprint')
                return { side: 'api-desktop' }
            }
        },
        login: {
            login: async page => {
                events.push(`${page.side}-login`)
                failAt('login')
            },
            getAppAccessToken: async () => 'fixture-token'
        },
        browser: {
            func: {
                checkpointActiveSession: async () => failAt('checkpoint'),
                closeBrowser: async (context, email, persist = true) => {
                    assert.equal(email, account.email)
                    events.push(`${context.side}-close:${persist ? 'save' : 'discard'}`)
                },
                getDashboardData: async () => ({
                    dashboard: {
                        userStatus: { availablePoints: 973 },
                        userProfile: { attributes: { country: 'CN' } }
                    }
                }),
                getBrowserEarnablePoints: async () => ({ mobileSearchPoints: 0, desktopSearchPoints: 0 }),
                getAppDashboardData: async () => ({}),
                getAppEarnablePoints: async () => ({ totalEarnablePoints: 0 }),
                getCurrentPoints: async () => 978
            }
        },
        activities: {
            needsDefaultSearch: async () => {
                assert.equal(bot.isMobile, true)
                events.push('dse-check')
                return needed
            },
            doDefaultSearch: async () => {
                assert.equal(bot.isMobile, false)
                events.push('dse')
            },
            doDailySet: async () => events.push('daily-set'),
            doDailyCheckIn: async () => events.push('app-check-in'),
            doAppPromotions: async () => events.push('app-promotions'),
            doReadToEarn: async () => events.push('read-to-earn'),
            doVisualSearch: async () => events.push('visual-search')
        },
        searchManager: {
            getSearchPoints: async () => ({ doMobile: quota, doDesktop: quota }),
            searchMobile: async () => {
                events.push('mobile-search')
                return 0
            },
            searchDesktop: async () => {
                if (api) {
                    const fallback = !needed || !!desktopFailure
                    assert.deepEqual(bot.cookies.desktop, cookies(fallback ? 'mobile' : 'desktop'))
                    assert.equal(bot.fingerprintDesktop.side, fallback ? 'api-desktop' : 'desktop')
                }
                events.push('desktop-search')
                return 0
            }
        }
    })
    bot.browser.func = Object.assign(new BrowserFunc(bot), bot.browser.func)
    const run = () => bot.Main(account)
    const count = event => events.filter(item => item === event).length
    return { bot, run, events, count, desktopError }
}

test('account orchestration runs DSE once with zero search quota in browser and both API modes', async () => {
    for (const mode of ['browser', 'api', 'hybrid', 'parallel', 'disabled']) {
        const f = accountFixture({ mode, needed: mode !== 'disabled', quota: mode === 'parallel' })
        assert.equal((await f.run()).collectedPoints, 5)
        assert.equal(f.count('dse'), mode === 'disabled' ? 0 : 1, mode)
        assert.equal(f.count('desktop-open'), mode === 'disabled' ? 0 : 1, mode)
        assert.equal(f.count('desktop-close:save'), mode === 'disabled' ? 0 : 1, mode)
        assert.equal(f.count('mobile-search'), mode === 'parallel' ? 1 : 0, mode)
        assert.equal(f.count('desktop-search'), mode === 'parallel' ? 1 : 0, mode)
    }
})

test('DSE-only desktop initialization failures leave daily, App and API search tasks running', async () => {
    for (const mode of ['api', 'hybrid']) {
        for (const desktopFailure of ['launch', 'page', 'login', 'checkpoint', 'cookies']) {
            const f = accountFixture({ mode, desktopFailure })
            assert.equal((await f.run()).collectedPoints, 5)
            assert.equal(f.count('dse'), 0)
            assert.equal(f.count('desktop-close:discard'), desktopFailure === 'launch' ? 0 : 1)
            assert.equal(f.count('desktop-close:save'), 0)
            assert.equal(f.count('api-desktop-fingerprint'), 1)
            for (const event of [
                'daily-set',
                'app-check-in',
                'app-promotions',
                'read-to-earn',
                'mobile-search',
                'desktop-search'
            ]) {
                assert.equal(f.count(event), 1, `${mode}/${desktopFailure}/${event}`)
            }
        }
    }
})

test('DSE failure with no search quota does not prepare an unnecessary API fingerprint', async () => {
    for (const mode of ['browser', 'api', 'hybrid']) {
        const f = accountFixture({ mode, quota: false, desktopFailure: 'login' })
        assert.equal((await f.run()).collectedPoints, 5)
        assert.equal(f.count('desktop-close:discard'), 1)
        assert.equal(f.count('api-desktop-fingerprint'), 0)
        assert.equal(f.count('desktop-search'), 0)
        assert.equal(f.count('daily-set'), 1)
    }
})

test('API searches without a DSE activity keep the original mobile-session fallback', async () => {
    for (const mode of ['api', 'hybrid']) {
        const f = accountFixture({ mode, needed: false, prewarm: true })
        await f.run()
        assert.equal(f.count('desktop-open'), 0)
        assert.equal(f.count('api-desktop-fingerprint'), 1)
        assert.equal(f.count('desktop-search'), 1)
    }
})

test('one transient desktop timeout retries only initialization and runs activities once', async () => {
    for (const mode of ['api', 'hybrid', 'parallel']) {
        const f = accountFixture({ mode, transientFailures: 1 })
        await f.run()
        assert.equal(f.count('desktop-open'), 2)
        assert.equal(f.count('desktop-close:discard'), 1)
        assert.equal(f.count('retry-wait:5000'), 1)
        assert.equal(f.count('daily-set'), 1)
        assert.equal(f.count('read-to-earn'), 1)
        assert.equal(f.count('dse'), 1)
    }
})

test('repeated transient desktop failure is bounded and never submits default search', async () => {
    const f = accountFixture({ mode: 'hybrid', required: true, transientFailures: 3 })
    await assert.rejects(f.run, /Timeout 20000ms/)
    assert.equal(f.count('desktop-open'), 2)
    assert.equal(f.count('retry-wait:5000'), 1)
    assert.equal(f.count('dse'), 0)
    assert.equal(f.count('daily-set'), 1)
})

test('successful desktop initialization preserves desktop cookies for API searches', async () => {
    for (const mode of ['api', 'hybrid']) {
        const f = accountFixture({ mode })
        await f.run()
        assert.equal(f.count('dse'), 1)
        assert.equal(f.count('api-desktop-fingerprint'), 0)
        assert.equal(f.count('desktop-search'), 1)
    }
})

test('DSE participates in prewarming before daily activities and only executes once', async () => {
    for (const mode of ['api', 'hybrid']) {
        const f = accountFixture({ mode, prewarm: true })
        await f.run()
        assert.equal(f.count('dse-check'), 1)
        assert.equal(f.count('desktop-open'), 2)
        assert.equal(f.count('desktop-close:save'), 2)
        assert.equal(f.count('dse'), 1)
        assert.ok(f.events.indexOf('desktop-login') < f.events.indexOf('daily-set'))
        assert.ok(f.events.indexOf('desktop-close:save') < f.events.indexOf('mobile-close:save'))
    }
})

test('failed DSE prewarming and later initialization both clean up and preserve API tasks', async () => {
    const f = accountFixture({ prewarm: true, desktopFailure: 'login' })
    assert.equal((await f.run()).collectedPoints, 5)
    assert.equal(f.count('desktop-open'), 2)
    assert.equal(f.count('desktop-close:discard'), 2)
    assert.equal(f.count('dse'), 0)
    assert.equal(f.count('daily-set'), 1)
    assert.equal(f.count('desktop-search'), 1)
})

test('desktop failures still propagate when other activities require the desktop browser', async () => {
    for (const options of [{ required: true }, { mode: 'browser' }, { mode: 'parallel' }]) {
        const f = accountFixture({ ...options, desktopFailure: 'login' })
        await assert.rejects(f.run(), error => error === f.desktopError)
        assert.equal(f.count('desktop-close:discard'), 1)
        assert.equal(f.count('dse'), 0)
        assert.equal(f.count('desktop-search'), 0)
    }
})

function bootstrapFixture({ mode = 'api', needed = true, prewarm = false, validDesktop = false, desktopFailure } = {}) {
    const f = accountFixture({
        mode,
        needed,
        prewarm,
        desktopFailure: desktopFailure ?? (validDesktop ? undefined : 'bootstrap')
    })
    const { bot } = f
    const promotion = {
        offerId: 'fixture_daily_5',
        title: 'Fixture daily activity',
        promotionType: 'urlreward',
        hash: 'fixture-hash',
        pointProgressMax: 5,
        complete: false,
        activityType: '11'
    }
    const reports = []
    const snapshots = {}
    const actions = { mobile: 'a'.repeat(40), desktop: 'b'.repeat(40) }
    const browserFunc = bot.browser.func
    bot.browser = { react: new ReactFunc(bot), func: browserFunc }
    bot.config.activities.urlReward = true
    bot.utils = {
        wait: async ms => f.events.push(`retry-wait:${ms}`),
        getFormattedDate: () => '10/07/2026',
        serverActionAcknowledged: Utils.prototype.serverActionAcknowledged
    }
    const getDashboardData = browserFunc.getDashboardData
    browserFunc.getDashboardData = async () => {
        const data = await getDashboardData()
        data.dashboard.dailySetPromotions = { '10/07/2026': [promotion] }
        return data
    }
    browserFunc.getCurrentPoints = async () => 973 + reports.length * 5
    const pageFor = (side, valid = side === 'mobile' || validDesktop) => {
        const source = valid
            ? '<section id="dailyset"></section>' +
              html(promotion, { availablePoints: 973 }) +
              `<script src="/_next/static/chunks/${side}.js?dpl=${side}-build"></script>`
            : '<html>Sign in</html><script src="/_next/static/chunks/login.js?dpl=rejected-build"></script>'
        return {
            goto: async () => {},
            waitForSelector: async () => null,
            content: async () => source,
            request: {
                get: async url => ({
                    ok: () => true,
                    text: async () =>
                        url.includes('/_next/')
                            ? valid
                                ? `createServerReference("${actions[side]}", "reportActivity")`
                                : '// login bundle'
                            : source
                })
            }
        }
    }
    bot.login.login = async page => {
        f.events.push(`${page.side}-login`)
        await browserFunc.bootstrap(pageFor(page.side))
        snapshots[page.side] = bot.reactSnapshot
    }
    bot.activities.doDailySet = data => new DailySet(bot).run(data)
    bot.activities.doUrlReward = item => new UrlReward(bot).doUrlReward(item)
    bot.http.request = async request => {
        assert.equal(request.method, 'POST')
        assert.equal(request.url, 'https://rewards.bing.com/dashboard')
        reports.push(request)
        return { status: 200, headers: {}, data: `1:true\n2:{"availablePoints":${973 + reports.length * 5}}` }
    }
    return { ...f, browserFunc, reports, snapshots, actions, pageFor }
}

test('failed DSE bootstrap preserves actual daily reports, including after failed prewarming', async () => {
    for (const options of [{ needed: false }, {}, { prewarm: true }, { mode: 'hybrid', prewarm: true }]) {
        const f = bootstrapFixture(options)
        const result = await f.run()
        assert.equal(f.reports.length, 1, JSON.stringify(options))
        assert.equal(result.collectedPoints, 5)
        assert.equal(f.reports[0].headers['Next-Action'], f.actions.mobile)
        assert.equal(f.reports[0].headers['X-Deployment-Id'], 'mobile-build')
        assert.equal(f.bot.nextActions.reportActivity, f.actions.mobile)
        assert.strictEqual(f.bot.reactSnapshot, f.snapshots.mobile)
        assert.strictEqual(f.bot.reactSnapshots.mobile, f.snapshots.mobile)
        assert.equal(f.bot.reactSnapshots.desktop, null)
        assert.equal(f.count('desktop-close:discard'), options.needed === false ? 0 : options.prewarm ? 4 : 2)
        assert.equal(f.count('dse'), 0)
        assert.equal(f.count('desktop-search'), 1)
    }
})

test('a verified desktop bootstrap commits the new action IDs, deployment and snapshot', async () => {
    const f = bootstrapFixture({ validDesktop: true })
    assert.equal((await f.run()).collectedPoints, 5)
    assert.equal(f.reports.length, 1)
    assert.equal(f.reports[0].headers['Next-Action'], f.actions.desktop)
    assert.equal(f.reports[0].headers['X-Deployment-Id'], 'desktop-build')
    assert.strictEqual(f.bot.reactSnapshot, f.snapshots.desktop)
    assert.strictEqual(f.bot.reactSnapshots.mobile, f.snapshots.mobile)
    assert.strictEqual(f.bot.reactSnapshots.desktop, f.snapshots.desktop)
    assert.equal(f.count('dse'), 1)
})

function lateDesktopFailureFixture({ stage = 'storage', failAfterPrewarm = false, ...options } = {}) {
    const f = bootstrapFixture({ ...options, validDesktop: true, desktopFailure: stage })
    const { bot, browserFunc } = f
    const originalLogin = bot.login.login
    const published = []
    const successfulDesktopPages = []
    const storageError = new Error('fixture browser closed while saving session')
    let desktopLogins = 0
    const recordPublished = () => published.push({ actions: bot.nextActions, snapshot: bot.reactSnapshot })
    // Use the real finalization sequence without constructing credential/login handlers.
    // storageState always throws here, before saveStorageState can touch disk.
    const finalizer = Object.assign(Object.create(Login.prototype), { bot, verifyBingSession: async () => {} })
    bot.browser.utils = { tryDismissAllMessages: async () => {} }
    bot.login.login = async (page, account) => {
        if (page.side === 'mobile' || (failAfterPrewarm && ++desktopLogins === 1)) {
            await originalLogin(page)
            if (page.side === 'desktop') successfulDesktopPages.push(page)
            return
        }
        f.events.push('desktop-login')
        const failedPage = f.pageFor('desktop')
        const originalGet = failedPage.request.get
        failedPage.request.get = async url => {
            if (url.includes('/_next/')) throw new Error('fixture browser closed during chunk download')
            return originalGet(url)
        }
        if (stage === 'storage') {
            failedPage.url = () => 'https://rewards.bing.com/earn'
            failedPage.context = () => ({
                storageState: async () => {
                    recordPublished()
                    throw storageError
                }
            })
            await finalizer.finalizeLogin(failedPage, account)
        } else {
            await browserFunc.bootstrap(failedPage)
            recordPublished()
            // The real createDesktopSession continues into the injected checkpoint/cookie failure.
        }
    }
    return { ...f, published, successfulDesktopPages, storageError }
}

test('late desktop initialization failures restore working context and actual daily reports', async () => {
    for (const options of [
        { needed: false },
        {},
        { prewarm: true },
        { mode: 'hybrid', prewarm: true },
        { stage: 'checkpoint' },
        { stage: 'cookies', prewarm: true }
    ]) {
        const f = lateDesktopFailureFixture(options)
        const result = await f.run()
        const failures = options.needed === false ? 0 : options.prewarm ? 2 : 1
        assert.equal(f.published.length, failures)
        for (const state of f.published) {
            assert.deepEqual(state.actions, {})
            assert.notStrictEqual(state.snapshot, f.snapshots.mobile)
        }
        assert.equal(f.reports.length, 1, JSON.stringify(options))
        assert.equal(result.collectedPoints, 5)
        assert.equal(f.reports[0].headers['Next-Action'], f.actions.mobile)
        assert.equal(f.reports[0].headers['X-Deployment-Id'], 'mobile-build')
        assert.equal(f.bot.nextActions.reportActivity, f.actions.mobile)
        assert.strictEqual(f.bot.reactSnapshot, f.snapshots.mobile)
        assert.strictEqual(f.bot.reactSnapshots.mobile, f.snapshots.mobile)
        assert.equal(f.bot.reactSnapshots.desktop, null)
        assert.equal(f.count('desktop-close:discard'), failures)
        assert.equal(f.count('dse'), 0)
        assert.equal(f.count('mobile-search'), 1)
        assert.equal(f.count('desktop-search'), 1)
    }
})

test('a late failure after successful prewarming restores the last successful desktop context', async () => {
    const f = lateDesktopFailureFixture({ prewarm: true, failAfterPrewarm: true })
    assert.equal((await f.run()).collectedPoints, 5)
    assert.equal(f.published.length, 1)
    assert.deepEqual(f.published[0].actions, {})
    assert.equal(f.reports.length, 1)
    assert.equal(f.reports[0].headers['Next-Action'], f.actions.desktop)
    assert.equal(f.reports[0].headers['X-Deployment-Id'], 'desktop-build')
    assert.strictEqual(f.bot.reactSnapshot, f.snapshots.desktop)
    assert.strictEqual(f.bot.reactSnapshots.desktop, f.snapshots.desktop)
    assert.strictEqual(f.bot.reactSnapshots.mobile, f.snapshots.mobile)
    assert.strictEqual(f.bot.mainDesktopPage, f.successfulDesktopPages[0])
    assert.equal(f.count('desktop-close:save'), 1)
    assert.equal(f.count('desktop-close:discard'), 1)
    assert.equal(f.count('dse'), 0)
})

test('required desktop errors still propagate after restoring context, even if cleanup fails', async () => {
    const f = lateDesktopFailureFixture()
    f.bot.config.workers.doVisualSearch = true
    const closeBrowser = f.browserFunc.closeBrowser
    f.browserFunc.closeBrowser = async (...args) => {
        await closeBrowser(...args)
        if (args[0].side === 'desktop') throw new Error('fixture cleanup failure')
    }
    await assert.rejects(f.run(), error => error === f.storageError)
    assert.equal(f.bot.nextActions.reportActivity, f.actions.mobile)
    assert.strictEqual(f.bot.reactSnapshot, f.snapshots.mobile)
    assert.equal(f.bot.reactSnapshots.desktop, null)
    assert.equal(f.bot.mainDesktopPage, undefined)
    assert.equal(f.bot.fingerprintDesktop, undefined)
    assert.deepEqual(f.bot.cookies.desktop, [])
    assert.equal(f.count('desktop-close:discard'), 1)
    assert.equal(f.reports.length, 0)
})
