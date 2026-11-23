import type { MicrosoftRewardsBot } from '../../../index'
import type { Counters, DashboardImpression } from '../../../interface/DashboardData'
import type { MissingSearchPoints } from '../../../interface/Points'

export interface SearchQuota {
    earned: number
    max: number
    remaining: number
}

export interface SearchQuotas {
    mobile: SearchQuota
    desktop: SearchQuota
    edge: SearchQuota
}

const QUOTA_RETRY_DELAYS = [3000, 5000]

export class SearchProgress {
    constructor(private readonly bot: MicrosoftRewardsBot) {}

    public async getCounters(): Promise<Counters> {
        for (let attempt = 0; ; attempt++) {
            try {
                const dashboard = await this.bot.browser.func.getDashboardData()
                const counters = dashboard?.dashboard?.userStatus?.counters
                if (!counters || !Array.isArray(counters.pcSearch) || !Array.isArray(counters.mobileSearch)) {
                    throw new Error('搜索配额数据缺失，无法确认是否完成')
                }
                for (const counter of [...counters.pcSearch, ...counters.mobileSearch]) {
                    if (
                        !counter ||
                        ![counter.pointProgress, counter.pointProgressMax].every(
                            (value: unknown) =>
                                (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
                                Number.isSafeInteger(Number(value)) &&
                                Number(value) >= 0
                        )
                    ) {
                        throw new Error('搜索配额数值无效，无法确认是否完成')
                    }
                }
                return counters
            } catch (error) {
                const delay = QUOTA_RETRY_DELAYS[attempt]
                if (delay === undefined || !this.isTransientError(error)) throw error
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'SEARCH-QUOTA',
                    `积分查询暂时失败，${delay / 1000} 秒后重试（${attempt + 1}/${QUOTA_RETRY_DELAYS.length}）；期间不发起新搜索`
                )
                await this.bot.utils.wait(delay)
            }
        }
    }

    private isTransientError(error: unknown): boolean {
        const failure = error as { status?: number; response?: { status?: number } } | null
        const status = failure?.status ?? failure?.response?.status
        if (typeof status === 'number') return [408, 425, 429].includes(status) || (status >= 500 && status < 600)
        const message = error instanceof Error ? error.message : String(error)
        if (/\b(?:401|403)\b/.test(message)) return false
        return /timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|connection (?:reset|closed)|error (?:sending request|trying to connect)/i.test(
            message
        )
    }

    public async getMissing(isMobile: boolean): Promise<MissingSearchPoints> {
        return (await this.getSnapshot(isMobile)).missing
    }

    public async getSnapshot(isMobile: boolean): Promise<{ missing: MissingSearchPoints; maximum: number }> {
        const counters = await this.getCounters()
        const quotas = this.calculateQuotas(counters)
        return {
            missing: this.calculateMissing(counters, isMobile),
            maximum: isMobile ? quotas.mobile.max : quotas.desktop.max + quotas.edge.max
        }
    }

    public calculateMissing(counters: Counters, isMobile: boolean): MissingSearchPoints {
        const quotas = this.calculateQuotas(counters)
        const mobilePoints = quotas.mobile.remaining
        const desktopPoints = quotas.desktop.remaining
        const edgePoints = quotas.edge.remaining

        return {
            mobilePoints,
            desktopPoints,
            edgePoints,
            totalPoints: isMobile ? mobilePoints : desktopPoints + edgePoints
        }
    }

    public calculateQuotas(counters: Counters): SearchQuotas {
        const pcCounters = counters.pcSearch ?? []
        const explicitEdgeCounters = pcCounters.filter(counter => this.isEdgeCounter(counter))
        const desktopCounters = explicitEdgeCounters.length
            ? pcCounters.filter(counter => !this.isEdgeCounter(counter))
            : pcCounters

        return {
            mobile: this.summarize(counters.mobileSearch ?? []),
            desktop: this.summarize(desktopCounters),
            edge: this.summarize(explicitEdgeCounters)
        }
    }

    private summarize(counters: DashboardImpression[]): SearchQuota {
        return counters.reduce<SearchQuota>(
            (quota, counter) => {
                const max = Math.max(0, Number(counter.pointProgressMax) || 0)
                const earned = Math.min(max, Math.max(0, Number(counter.pointProgress) || 0))
                quota.earned += earned
                quota.max += max
                quota.remaining += max - earned
                return quota
            },
            { earned: 0, max: 0, remaining: 0 }
        )
    }

    private isEdgeCounter(counter: DashboardImpression): boolean {
        return [counter.offerId, counter.name, counter.title, counter.promotionSubtype].some(
            value => typeof value === 'string' && /(^|[_\s-])edge([_\s-]|$)/i.test(value)
        )
    }
}
