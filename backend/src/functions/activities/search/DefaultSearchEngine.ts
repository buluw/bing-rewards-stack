import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../../index'
import type { DefaultSearchProgress } from '../../../browser/ReactFunc'
import { URLs } from '../../../constants/urls'
import { DefaultSearchState, defaultSearchDay, type DefaultSearchAttempt } from '../../../util/DefaultSearchState'
import { SearchQueryQueue } from '../../SearchQueryQueue'
import { BaseActivity } from '../BaseActivity'

const LOG = 'DEFAULT-SEARCH'
class DefaultSearchError extends Error {}

export class DefaultSearchEngine extends BaseActivity {
    private readonly state: DefaultSearchState

    constructor(
        bot: MicrosoftRewardsBot,
        private readonly now: () => number = Date.now
    ) {
        super(bot)
        this.state = new DefaultSearchState(bot.config.sessionPath)
    }

    private pending(progress: DefaultSearchProgress | null | undefined): progress is DefaultSearchProgress {
        return !!progress && !progress.isCompleted && progress.days < progress.daysMax
    }

    public async needsRun(): Promise<boolean> {
        if (!this.bot.config.workers.doDesktopSearch) return false
        const email = this.bot.currentAccountEmail
        if (!email) return false
        try {
            if (this.state.hasAttempt(email, defaultSearchDay(this.now()))) {
                this.bot.logger.info(false, LOG, '今天已尝试默认搜索任务，跳过重复搜索')
                return false
            }
            const snapshot = await this.bot.browser.func.refreshEarnSnapshot()
            const needed = this.pending(snapshot?.defaultSearch)
            if (!needed) this.bot.logger.info(false, LOG, '没有可执行的默认搜索任务，或官方进度不可用')
            return needed
        } catch {
            this.bot.logger.warn(false, LOG, '无法读取默认搜索任务或本地记录，本轮跳过')
            return false
        }
    }

    private async readProgress(page: Page): Promise<DefaultSearchProgress | null> {
        const response = await page.context().request.get(URLs.rewards.earn, {
            headers: { 'Cache-Control': 'no-cache' },
            maxRedirects: 0,
            timeout: 15000
        })
        try {
            if (response.status() !== 200) {
                throw new DefaultSearchError(`官方进度请求失败：HTTP ${response.status()}`)
            }
            return this.bot.browser.react.getDefaultSearchProgress(await response.text())
        } finally {
            await response.dispose()
        }
    }

    public async run(page: Page): Promise<void> {
        if (!this.bot.config.workers.doDesktopSearch) return
        const email = this.bot.currentAccountEmail
        if (!email) return
        let attempt: DefaultSearchAttempt | null = null
        let confirmedDays: number | undefined
        try {
            if (this.state.hasAttempt(email, defaultSearchDay(this.now()))) return
            const queries = new SearchQueryQueue(this.bot)
            await queries.prepare()
            const query = await queries.next()
            if (!query) throw new DefaultSearchError('没有可用搜索词')

            await this.bot.browser.func.synchronizeActiveBrowserCookies('DEFAULT-SEARCH-SEED', true)
            const day = defaultSearchDay(this.now())
            const before = await this.readProgress(page)
            const reservedAt = this.now()
            if (!this.pending(before)) {
                this.bot.logger.info(false, LOG, '官方任务已结束或进度不可用，本次不搜索')
                return
            }
            if (day !== defaultSearchDay(reservedAt)) return
            attempt = this.state.reserve(email, before.days, reservedAt)
            if (!attempt) return

            const url = new URL('/search', URLs.bing.origin)
            // Observed Chromium Bing source parameters; no native address bar or policy is required.
            url.search = new URLSearchParams({ q: query, FORM: 'CHROMN', PC: 'U316' }).toString()
            this.bot.logger.info(false, LOG, `开始每日默认搜索 | 官方进度=${before.days}/${before.daysMax}`)
            const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 })
            const finalUrl = new URL(page.url())
            if (
                !response?.ok() ||
                !['www.bing.com', 'cn.bing.com', 'bing.com'].includes(finalUrl.hostname) ||
                finalUrl.pathname !== '/search' ||
                finalUrl.searchParams.get('q') !== query
            ) {
                throw new DefaultSearchError('未能确认必应搜索结果页')
            }
            await this.bot.browser.func.synchronizeActiveBrowserCookies('DEFAULT-SEARCH-CAPTURE')
            const searchedAt = this.now()
            for (const delay of [0, 15000, 60000, 120000]) {
                const wait = searchedAt + delay - this.now()
                if (wait > 0) await this.bot.utils.wait(wait)
                if (defaultSearchDay(this.now()) !== attempt.day) break
                const after = await this.readProgress(page)
                if (defaultSearchDay(this.now()) !== attempt.day) break
                if (!after || after.daysMax !== before.daysMax || after.days < before.days) {
                    throw new DefaultSearchError('官方任务进度缺失或发生重置，无法确认本次结果')
                }
                if (after.days > before.days) {
                    confirmedDays = after.days
                    this.bot.logger.info(
                        false,
                        LOG,
                        `默认搜索任务已计数 | ${before.days} → ${after.days}/${after.daysMax}`
                    )
                    return
                }
            }
            this.bot.logger.warn(false, LOG, '未确认新增任务天数，可能今天已在其他客户端计数；当天不重复搜索')
        } catch (error) {
            const reason = error instanceof DefaultSearchError ? error.message : '浏览器请求或本地记录操作失败'
            this.bot.logger.warn(false, LOG, `${reason}；未确认任务成功，继续其他任务`)
        } finally {
            if (attempt) {
                try {
                    this.state.finish(email, attempt, confirmedDays)
                } catch {
                    this.bot.logger.warn(false, LOG, '无法保存确认结果，保留当天尝试记录以避免重复搜索')
                }
            }
        }
    }
}
