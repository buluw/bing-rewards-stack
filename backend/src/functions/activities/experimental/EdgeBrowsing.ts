import type { Cookie } from 'patchright'

import { URLs } from '../../../constants/urls'
import type { EdgeBrowsingServerProgress, ParsedOffer, StreakState } from '../../../browser/ReactFunc'
import type { MicrosoftRewardsBot } from '../../../index'
import type { AppDashboardData, Promotion } from '../../../interface/AppDashBoardData'
import type { DashboardData } from '../../../interface/DashboardData'
import { BaseActivity } from '../BaseActivity'
import { EdgeBrowsingProgress, type EdgeBrowsingProgressSnapshot } from './EdgeBrowsingProgress'

const LOG_TAG = 'EDGE-BROWSING'
const PROMOTION_NAME = 'edge_browsing_streak_flight'
const EDGE_BROWSING_ACTIVATION_OFFER = 'edge_flight_1_ww_treatment_eligible'

const VERIFIED_ACTIVITY_TYPES = new Map<string, number>([['edge_flight_1_ww_treatment_eligible', 714]])
const TARGET_DURATION_MINUTES = 30
const DEFAULT_REPORT_INTERVAL_MINUTES = 5
const MIN_REPORT_INTERVAL_MINUTES = 1
const MAX_REPORT_INTERVAL_MINUTES = 30

const REPORT_JITTER_MIN_MS = 5_000
const REPORT_JITTER_MAX_MS = 20_000
const MAX_EXTRA_REPORTS = 2
const MAX_NO_PROGRESS_REPORTS = 3
const MAX_RUN_MS = 45 * 60_000
const CONFIRMATION_DELAYS_MS = [0, 15_000, 45_000] as const

interface EdgeBrowsingSettings {
    offerId: string
    activityType: string
    reportIntervalMinutes: number
    promotion: Promotion
}

interface EdgeActivityResponse {
    code?: number
    response?: {
        activity?: {
            type?: number | string
            q?: number | string
            a?: { offerid?: string }
        }
        isDuplicate?: boolean
    }
}

interface ReportResult {
    status: number
    outcome: 'acknowledged' | 'duplicate' | 'uncertain'
    cookieNames: string[]
}

type ActivationResult = 'activated' | 'already-active' | 'absent' | 'failed'

interface ActivationMetadata {
    activityType: number
    activityTypeSource: 'react' | 'streak' | 'dashboard' | 'verified-fallback'
    isPromotional: boolean
}

interface ActivationTarget extends ParsedOffer {
    activationSource: 'streak' | 'offer'
}

export class EdgeBrowsing extends BaseActivity {
    constructor(
        bot: MicrosoftRewardsBot,
        private readonly now: () => number = Date.now
    ) {
        super(bot)
    }

    public async run(data: DashboardData, signal?: AbortSignal): Promise<void> {
        const accessToken = this.bot.accessToken
        if (!accessToken) {
            this.bot.logger.warn(this.bot.isMobile, LOG_TAG, '跳过：移动应用访问令牌不可用')
            return
        }

        try {
            let profile = await this.getEdgeProfile(accessToken)
            if (signal?.aborted) return

            if (!this.findPromotion(profile)) {
                const activation = await this.activate(data, signal)
                if (signal?.aborted) return

                if (activation === 'absent') {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        LOG_TAG,
                        '该账户无法使用 Edge 浏览连击（Browsing Streak）'
                    )
                    return
                }

                if (activation === 'failed') return

                profile = await this.getEdgeProfile(accessToken)
                if (signal?.aborted) return
            }

            const settings = this.resolveSettings(profile)
            if (!settings) return

            const complete = this.promotionComplete(settings.promotion) === true
            if (complete) {
                this.bot.logger.info(this.bot.isMobile, LOG_TAG, 'Edge 浏览连击（Browsing Streak）已完成')
                return
            }

            await this.runReports(accessToken, settings, signal)
        } catch (error) {
            if (signal?.aborted) {
                this.bot.logger.debug(this.bot.isMobile, LOG_TAG, '后台活动已取消')
                return
            }

            this.bot.logger.error(
                this.bot.isMobile,
                LOG_TAG,
                `后台 Edge 浏览活动失败 | message=${
                    error instanceof Error ? error.message : String(error)
                }`
            )
        }
    }

    private async runReports(accessToken: string, settings: EdgeBrowsingSettings, signal?: AbortSignal): Promise<void> {
        const startedAt = this.now()
        const dayKey = this.dayKey()
        const interrupted = (): string | null =>
            signal?.aborted
                ? 'cancelled'
                : this.dayKey() !== dayKey
                  ? 'day-changed'
                  : this.now() - startedAt >= MAX_RUN_MS
                    ? 'time-limit'
                    : null
        let state = await this.refreshServerProgress(accessToken)
        let confirmedMinutes = state?.minutes ?? null
        let currentDay = state?.currentDay ?? null
        const plannedReports = Math.ceil(
            (TARGET_DURATION_MINUTES - (confirmedMinutes ?? 0)) / settings.reportIntervalMinutes
        )
        const maxAttempts = plannedReports + MAX_EXTRA_REPORTS
        const delays = Array.from(
            { length: maxAttempts },
            () =>
                settings.reportIntervalMinutes * 60_000 +
                this.bot.utils.randomDelay(REPORT_JITTER_MIN_MS, REPORT_JITTER_MAX_MS)
        )
        const progress = new EdgeBrowsingProgress(
            TARGET_DURATION_MINUTES,
            settings.reportIntervalMinutes,
            delays,
            this.now
        )
        let attempted = 0
        let accepted = 0
        let duplicates = 0
        let uncertain = 0
        let failed = 0
        let noProgress = 0
        let stopReason = 'attempt-limit'
        const snapshot = (): EdgeBrowsingProgressSnapshot =>
            progress.snapshot(attempted, confirmedMinutes, state !== null)
        const observe = (next: EdgeBrowsingServerProgress | null): string | null => {
            if (!next) {
                state = null
                return 'progress-unavailable'
            }
            if (currentDay !== null && next.currentDay !== null && next.currentDay !== currentDay) {
                state = null
                return 'day-changed'
            }
            if (confirmedMinutes !== null && next.minutes < confirmedMinutes && !next.complete) {
                state = null
                return 'progress-regressed'
            }
            // Count every validated advance, including delayed credit discovered before a later POST.
            if (confirmedMinutes !== null && next.minutes > confirmedMinutes) noProgress = 0
            state = next
            confirmedMinutes = next.complete ? TARGET_DURATION_MINUTES : next.minutes
            currentDay ??= next.currentDay
            if (next.complete) return 'complete'
            if (!next.enabled) return 'disabled'
            return null
        }

        this.bot.logger.info(
            this.bot.isMobile,
            LOG_TAG,
            `开始后台 Edge 浏览活动 | offerId=${settings.offerId} | type=${settings.activityType}` +
                ` | targetMinutes=${TARGET_DURATION_MINUTES} | reports=${progress.reportsTotal}` +
                ` | plannedReports=${plannedReports} | maxAttempts=${maxAttempts}` +
                ` | serverIntervalMinutes=${settings.reportIntervalMinutes}` +
                ` | estimatedDurationMinutes=${snapshot().estimatedRemainingMinutes ?? 'unknown'} | ` +
                this.formatProgress(snapshot(), accepted, duplicates, failed, uncertain).replace('Edge 浏览进度 | ', '')
        )

        while (attempted < maxAttempts) {
            const reason = interrupted() ?? observe(state)
            if (reason) {
                stopReason = reason
                break
            }
            // A full minute counter with a pending completion flag only needs reads, never another POST.
            if (confirmedMinutes === TARGET_DURATION_MINUTES) {
                const next = await this.pollServerProgress(
                    accessToken,
                    confirmedMinutes,
                    currentDay,
                    interrupted,
                    signal
                )
                stopReason = interrupted() ?? observe(next) ?? 'completion-unconfirmed'
                break
            }

            this.logProgress(snapshot(), accepted, duplicates, failed, uncertain)
            const delay = progress.delayBeforeReport(attempted + 1)
            if (this.now() + delay - startedAt >= MAX_RUN_MS) {
                stopReason = 'time-limit'
                break
            }
            if (!(await this.wait(delay, signal))) {
                stopReason = 'cancelled'
                break
            }
            const afterWait = interrupted()
            if (afterWait) {
                stopReason = afterWait
                break
            }

            // Re-read after the interval: a late acknowledgement or manual browsing may already have counted.
            const fresh = await this.refreshServerProgress(accessToken)
            const beforePost = interrupted() ?? observe(fresh)
            if (beforePost) {
                stopReason = beforePost
                break
            }
            if (confirmedMinutes === TARGET_DURATION_MINUTES) continue
            const beforeMinutes = confirmedMinutes as number
            let authorizationFailed = false
            attempted += 1
            try {
                const result = await this.submitReport(accessToken, settings)
                if (result.outcome === 'acknowledged') accepted += 1
                else if (result.outcome === 'duplicate') duplicates += 1
                else uncertain += 1
                this.bot.logger.info(
                    this.bot.isMobile,
                    LOG_TAG,
                    `已提交 Edge 浏览报告 | attemptedReports=${attempted} | status=${result.status}` +
                        ` | outcome=${result.outcome} | cookies=${result.cookieNames.join(',') || 'none'}`
                )
            } catch (error) {
                failed += 1
                const requestError = error as { status?: number; response?: { status?: number } }
                const status = requestError.response?.status ?? requestError.status
                authorizationFailed = status === 401 || status === 403
                this.bot.logger.warn(
                    this.bot.isMobile,
                    LOG_TAG,
                    `Edge 浏览报告提交失败 | attemptedReports=${attempted} | status=${status ?? 'unknown'}`
                )
            }

            // Even a timeout may have reached Microsoft. Reconcile with GETs before considering another interval.
            const next = await this.pollServerProgress(accessToken, beforeMinutes, currentDay, interrupted, signal)
            const afterPost = interrupted() ?? observe(next)
            this.logProgress(snapshot(), accepted, duplicates, failed, uncertain)
            if (afterPost) {
                stopReason = afterPost
                break
            }
            if (authorizationFailed) {
                stopReason = 'authorization-failed'
                break
            }
            if ((confirmedMinutes as number) <= beforeMinutes) noProgress += 1
            if (noProgress >= MAX_NO_PROGRESS_REPORTS) {
                stopReason = 'no-progress'
                break
            }
        }

        if (stopReason === 'day-changed' || stopReason === 'progress-regressed') state = null
        const serverComplete = stopReason === 'complete'
        const finished = {
            ...snapshot(),
            nextReportInSeconds: null,
            estimatedRemainingMinutes: serverComplete ? 0 : null
        }
        const summary =
            `后台 Edge 浏览活动结束 | reports=${attempted} | ` +
            this.formatProgress(finished, accepted, duplicates, failed, uncertain).replace('Edge 浏览进度 | ', '') +
            ` | serverComplete=${serverComplete ? 'true' : state ? 'false' : 'unknown'} | stopReason=${stopReason}`
        if (serverComplete) this.bot.logger.info(this.bot.isMobile, LOG_TAG, summary, 'green')
        else this.bot.logger.warn(this.bot.isMobile, LOG_TAG, summary)
        if (stopReason === 'cancelled') this.bot.logger.debug(this.bot.isMobile, LOG_TAG, '后台活动已取消')
    }

    private dayKey(): string {
        const configuredOffset = Number(this.bot.userData.timezoneOffset)
        const offset = Number.isFinite(configuredOffset) ? configuredOffset : new Date(this.now()).getTimezoneOffset()
        return new Date(this.now() - offset * 60_000).toISOString().slice(0, 10)
    }

    private async pollServerProgress(
        accessToken: string,
        beforeMinutes: number,
        currentDay: number | null,
        interrupted: () => string | null,
        signal?: AbortSignal
    ): Promise<EdgeBrowsingServerProgress | null> {
        let latest: EdgeBrowsingServerProgress | null = null
        for (const delay of CONFIRMATION_DELAYS_MS) {
            if (interrupted()) return null
            if (delay && !(await this.wait(delay, signal))) return null
            if (interrupted()) return null
            latest = await this.refreshServerProgress(accessToken)
            if (interrupted()) return null
            if (
                latest &&
                (latest.complete ||
                    latest.minutes !== beforeMinutes ||
                    !latest.enabled ||
                    (currentDay !== null && latest.currentDay !== null && latest.currentDay !== currentDay))
            )
                return latest
        }
        return latest
    }

    private async getEdgeProfile(accessToken: string): Promise<AppDashboardData> {
        const headers = { ...(this.bot.fingerprint?.headers ?? {}) }
        delete headers['Cookie']
        delete headers['cookie']

        const response = await this.bot.http.request<AppDashboardData>({
            url: URLs.platform.edgeProfile,
            method: 'GET',
            headers: {
                ...headers,
                Authorization: `Bearer ${accessToken}`,
                Accept: '*/*',
                'Accept-Language': this.bot.accountLocale.acceptLanguage,
                'X-Rewards-AppId': 'EdgeDesktop',
                'X-Rewards-PartnerId': 'EdgeHub',
                'X-Rewards-Country': this.bot.userData.geoLocale,
                'X-Rewards-Language': this.bot.accountLocale.locale,
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-Mode': 'no-cors',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Storage-Access': 'active'
            }
        })

        if (response.data.code !== 0) {
            throw new Error(`Edge 配置接口返回 code ${response.data.code ?? 'unknown'}`)
        }

        return response.data
    }

    private findStreak(streaks?: StreakState[]): StreakState | undefined {
        if (streaks) return streaks.find(streak => this.isEdgeBrowsingPartner(streak.partner))

        const snapshots = [this.bot.reactSnapshot, this.bot.reactSnapshots.desktop, this.bot.reactSnapshots.mobile]

        for (const snapshot of snapshots) {
            const streak = snapshot?.streaks.find(item => this.isEdgeBrowsingPartner(item.partner))
            if (streak) return streak
        }

        return undefined
    }

    private async activate(data: DashboardData, signal?: AbortSignal): Promise<ActivationResult> {
        const offer = this.findActivationTarget()
        if (!offer) {
            this.bot.logger.debug(
                this.bot.isMobile,
                LOG_TAG,
                'No Edge browsing activation metadata present in the streak model or generic offers across the current, desktop, or cached mobile Rewards snapshots'
            )
            return 'absent'
        }

        if (offer.isCompleted) {
            this.bot.logger.info(
                this.bot.isMobile,
                LOG_TAG,
                `Edge 浏览激活 offer 已完成 | offerId=${offer.offerId}`,
                'green'
            )
            return 'already-active'
        }

        if (!offer.hash) {
            this.bot.logger.warn(
                this.bot.isMobile,
                LOG_TAG,
                `激活 offer 存在但缺少 hash | offerId=${offer.offerId}`
            )
            return 'failed'
        }

        if (!offer.reportable && !offer.isLocked) {
            this.bot.logger.warn(
                this.bot.isMobile,
                LOG_TAG,
                `激活 offer 不可操作 | offerId=${offer.offerId}`
            )
            return 'failed'
        }

        const actionId = this.bot.nextActions.reportActivity
        if (!actionId) {
            this.bot.logger.warn(
                this.bot.isMobile,
                LOG_TAG,
                '跳过激活：bundle 中未发现 "reportActivity" action id'
            )
            return 'failed'
        }

        const dashboard = await this.resolveDashboard(data)
        const metadata = this.resolveActivationMetadata(offer, dashboard)
        if (!metadata) {
            this.bot.logger.warn(
                this.bot.isMobile,
                LOG_TAG,
                `跳过激活：未找到有效的 activityType | offerId=${offer.offerId}`
            )
            return 'failed'
        }

        this.bot.logger.info(
            this.bot.isMobile,
            LOG_TAG,
            `正在激活 Edge 浏览连击 | offerId=${offer.offerId} | activationSource=${offer.activationSource} | activityType=${metadata.activityType} | activityTypeSource=${metadata.activityTypeSource} | promotional=${metadata.isPromotional} | geo=${this.bot.userData.geoLocale}`
        )

        try {
            const { status, acknowledged } = await this.bot.browser.func.reportServerAction(actionId, [
                offer.hash,
                metadata.activityType,
                {
                    offerid: offer.offerId,
                    isPromotional: metadata.isPromotional ? 'true' : '$undefined',
                    timezoneOffset: this.bot.userData.timezoneOffset
                }
            ])

            if (!(await this.wait(this.bot.utils.randomDelay(3000, 6000), signal))) return 'failed'
            const confirmed = await this.confirmActivation(offer.offerId)

            if (acknowledged || confirmed) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    LOG_TAG,
                    `Edge 浏览连击已激活 | offerId=${offer.offerId} | acknowledged=${acknowledged} | confirmed=${confirmed}`,
                    'green'
                )
                return 'activated'
            }

            this.bot.logger.warn(
                this.bot.isMobile,
                LOG_TAG,
                `激活未被服务器确认 | offerId=${offer.offerId} | status=${status}`
            )
            return 'failed'
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                LOG_TAG,
                `激活出错 | offerId=${offer.offerId} | ${error instanceof Error ? error.message : String(error)}`
            )
            return 'failed'
        }
    }

    private async confirmActivation(offerId: string): Promise<boolean> {
        try {
            const snapshot = await this.bot.browser.func.refreshEarnSnapshot()
            if (!snapshot) return false

            this.bot.reactSnapshot = snapshot

            const streak = this.findStreak(snapshot.streaks)
            const activationOffer = snapshot.offers.find(o => o.offerId === offerId)
            return streak?.isEnabled === true || activationOffer?.isCompleted === true
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                LOG_TAG,
                `无法验证激活状态 | offerId=${offerId} | ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    private async resolveDashboard(fallback: DashboardData): Promise<DashboardData> {
        try {
            return await this.bot.browser.func.getDashboardData(this.bot.cookies.desktop)
        } catch {
            this.bot.logger.debug(
                this.bot.isMobile,
                LOG_TAG,
                'Desktop dashboard fetch failed - falling back to the dashboard from the mobile pass'
            )
            return fallback
        }
    }

    private resolveActivationMetadata(offer: ActivationTarget, data: DashboardData): ActivationMetadata | null {
        const dashboardPromotion = this.findDashboardPromotion(data.dashboard, offer.offerId)

        if (offer.activityType !== null) {
            return {
                activityType: offer.activityType,
                activityTypeSource: offer.activationSource === 'streak' ? 'streak' : 'react',
                isPromotional: offer.isPromotional || this.dashboardPromotionIsPromotional(dashboardPromotion)
            }
        }

        const dashboardActivityType = this.dashboardPromotionActivityType(dashboardPromotion)
        if (dashboardActivityType !== null) {
            return {
                activityType: dashboardActivityType,
                activityTypeSource: 'dashboard',
                isPromotional: offer.isPromotional || this.dashboardPromotionIsPromotional(dashboardPromotion)
            }
        }

        const verifiedFallback = VERIFIED_ACTIVITY_TYPES.get(offer.offerId.toLowerCase())
        if (verifiedFallback !== undefined) {
            return {
                activityType: verifiedFallback,
                activityTypeSource: 'verified-fallback',
                isPromotional: offer.isPromotional || this.dashboardPromotionIsPromotional(dashboardPromotion)
            }
        }

        return null
    }

    private findDashboardPromotion(root: unknown, offerId: string): Record<string, unknown> | null {
        const target = offerId.toLowerCase()
        const pending: unknown[] = [root]
        const visited = new Set<object>()

        while (pending.length) {
            const value = pending.pop()
            if (!value || typeof value !== 'object' || visited.has(value)) continue
            visited.add(value)

            if (Array.isArray(value)) {
                for (const entry of value) pending.push(entry)
                continue
            }

            const record = value as Record<string, unknown>
            const attributes = this.asRecord(record.attributes)
            const candidateId = record.offerId ?? record.offerid ?? attributes?.offerid
            if (typeof candidateId === 'string' && candidateId.toLowerCase() === target) return record

            for (const entry of Object.values(record)) pending.push(entry)
        }

        return null
    }

    private dashboardPromotionActivityType(promotion: Record<string, unknown> | null): number | null {
        if (!promotion) return null
        const attributes = this.asRecord(promotion.attributes)
        return this.parseActivityType(
            promotion.activityType ?? promotion.activity_type ?? attributes?.activityType ?? attributes?.activity_type
        )
    }

    private dashboardPromotionIsPromotional(promotion: Record<string, unknown> | null): boolean {
        if (!promotion) return false
        const attributes = this.asRecord(promotion.attributes)
        const value = promotion.isPromotional ?? promotion.promotional ?? attributes?.promotional
        return value === true || (typeof value === 'string' && value.toLowerCase() === 'true')
    }

    private parseActivityType(value: unknown): number | null {
        const parsed = Number(value)
        return Number.isInteger(parsed) && parsed > 0 ? parsed : null
    }

    private asRecord(value: unknown): Record<string, unknown> | null {
        return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
    }

    private findActivationTarget(): ActivationTarget | null {
        const snapshots = [
            { source: 'current', snapshot: this.bot.reactSnapshot },
            { source: 'desktop', snapshot: this.bot.reactSnapshots.desktop },
            { source: 'mobile', snapshot: this.bot.reactSnapshots.mobile }
        ] as const

        const seen = new Set<unknown>()

        // New Rewards format: activation metadata is carried directly by the streak model.
        for (const { source, snapshot } of snapshots) {
            if (!snapshot || seen.has(snapshot)) continue
            seen.add(snapshot)

            const streak = this.findStreak(snapshot.streaks)
            if (!streak?.activationOfferId || !streak.activationHash) continue

            if (source !== 'current') {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    LOG_TAG,
                    `当前快照缺少激活元数据；使用缓存的 ${source} streak 快照 | offerId=${streak.activationOfferId}`
                )
            } else {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    LOG_TAG,
                    `使用 streak 模型中的 Edge 浏览激活元数据 | offerId=${streak.activationOfferId}`
                )
            }

            return {
                offerId: streak.activationOfferId,
                hash: streak.activationHash,
                title: 'Browsing Streak on Edge',
                description: '',
                points: 0,
                promotionSubtype: null,
                destination: streak.destinationUrl ?? '',
                isCompleted: streak.isEnabled,
                isPromotional: false,
                isLocked: false,
                unlockCriteria: null,
                date: null,
                activityType: streak.activationActivityType,
                reportable: true,
                activationSource: 'streak'
            }
        }

        // Legacy/current alternate format: activation appears as a regular Rewards offer.
        seen.clear()
        for (const { source, snapshot } of snapshots) {
            if (!snapshot || seen.has(snapshot)) continue
            seen.add(snapshot)

            const exact = snapshot.offers.find(o => o.offerId === EDGE_BROWSING_ACTIVATION_OFFER)
            const fuzzy = snapshot.offers.find(o => {
                const id = o.offerId.toLowerCase()
                return id.includes('edge_flight') && (id.includes('eligible') || id.includes('activation'))
            })
            const offer = exact ?? fuzzy
            if (!offer) continue

            if (source !== 'current') {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    LOG_TAG,
                    `当前快照缺少激活 offer；使用缓存的 ${source} offer 快照 | offerId=${offer.offerId}`
                )
            } else {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    LOG_TAG,
                    `使用通用 offer 中的 Edge 浏览激活元数据 | offerId=${offer.offerId}`
                )
            }

            return { ...offer, activationSource: 'offer' }
        }

        return null
    }

    private isEdgeBrowsingPartner(partner: string): boolean {
        const normalized = partner.replace(/[^a-z]/gi, '').toLowerCase()
        return normalized === 'edge' || normalized.includes('edgebrows')
    }

    private findPromotion(profile: AppDashboardData): Promotion | undefined {
        return profile.response?.promotions?.find(item => item.name === PROMOTION_NAME)
    }

    private async refreshServerProgress(accessToken: string): Promise<EdgeBrowsingServerProgress | null> {
        const [html, profile] = await Promise.all([
            this.bot.browser.func.getRewardsPageHtml(URLs.rewards.earn + '?section=streaks', '/earn').catch(() => null),
            this.getEdgeProfile(accessToken).catch(() => null)
        ])
        const progress = html === null ? null : this.bot.browser.react.getEdgeBrowsingProgress(html)
        if (progress && progress.targetMinutes !== TARGET_DURATION_MINUTES) {
            this.bot.logger.warn(this.bot.isMobile, LOG_TAG, 'Edge 浏览目标与预期不符，停止自动上报')
            return null
        }
        const complete = profile ? this.promotionComplete(this.findPromotion(profile)) : null
        // A positive official completion flag is authoritative even if the minute page is temporarily unavailable.
        if (complete === true || progress?.complete) {
            return {
                minutes: TARGET_DURATION_MINUTES,
                targetMinutes: TARGET_DURATION_MINUTES,
                complete: true,
                enabled: progress?.enabled ?? true,
                currentDay: progress?.currentDay ?? null
            }
        }
        if (!progress)
            this.bot.logger.debug(this.bot.isMobile, LOG_TAG, '无法确认 Edge 浏览官方进度；不把缺失字段当成零')
        return progress
    }

    private promotionComplete(promotion?: Promotion): boolean | null {
        const value: unknown = promotion?.attributes?.['complete']
        if (value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true')) return true
        if (value === false || (typeof value === 'string' && value.trim().toLowerCase() === 'false')) return false
        return null
    }

    private resolveSettings(profile: AppDashboardData): EdgeBrowsingSettings | null {
        const promotion = this.findPromotion(profile)
        if (!promotion) {
            this.bot.logger.info(
                this.bot.isMobile,
                LOG_TAG,
                '该账户无法使用 Edge 浏览连击（Browsing Streak）'
            )
            return null
        }

        const offerId = promotion.attributes['offerid']?.trim()
        const activityType = promotion.attributes['report_offer_type']?.trim()
        if (!offerId || !activityType) {
            this.bot.logger.warn(
                this.bot.isMobile,
                LOG_TAG,
                `跳过：优惠元数据不完整 | offerId=${offerId || 'missing'}` +
                    ` | type=${activityType || 'missing'}`
            )
            return null
        }

        const advertisedInterval = Number(promotion.attributes['report_per_minutes'])
        const validInterval =
            Number.isFinite(advertisedInterval) &&
            advertisedInterval >= MIN_REPORT_INTERVAL_MINUTES &&
            advertisedInterval <= MAX_REPORT_INTERVAL_MINUTES
        const reportIntervalMinutes = validInterval ? advertisedInterval : DEFAULT_REPORT_INTERVAL_MINUTES

        if (!validInterval) {
            this.bot.logger.warn(
                this.bot.isMobile,
                LOG_TAG,
                `服务器上报间隔无效，使用回退值 | received=${
                    promotion.attributes['report_per_minutes'] ?? 'missing'
                } | fallbackMinutes=${DEFAULT_REPORT_INTERVAL_MINUTES}`
            )
        }

        return { offerId, activityType, reportIntervalMinutes, promotion }
    }

    private async submitReport(accessToken: string, settings: EdgeBrowsingSettings): Promise<ReportResult> {
        const { header: cookieHeader, names: cookieNames } = this.getPlatformCookieHeader()
        const headers = { ...(this.bot.fingerprint?.headers ?? {}) }
        delete headers['Cookie']
        delete headers['cookie']

        const response = await this.bot.http.request<EdgeActivityResponse>({
            url: URLs.platform.activities,
            method: 'POST',
            // A transport retry can duplicate a report already received by Microsoft.
            retries: 0,
            headers: {
                ...headers,
                Authorization: `Bearer ${accessToken}`,
                Accept: '*/*',
                'Accept-Language': this.bot.accountLocale.acceptLanguage,
                'Content-Type': 'application/json',
                'X-Rewards-AppId': 'EdgeDesktop',
                'X-Rewards-PartnerId': 'EdgeHub',
                'X-Rewards-Country': this.bot.userData.geoLocale,
                'X-Rewards-Language': this.bot.accountLocale.locale,
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-Mode': 'no-cors',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Storage-Access': 'active',
                ...(cookieHeader ? { Cookie: cookieHeader } : {})
            },
            data: {
                amount: 1,
                attributes: { offerid: settings.offerId },
                request_user_info: true,
                type: settings.activityType
            }
        })

        if (response.data.code !== 0) {
            throw new Error(`Edge 活动接口返回 code ${response.data.code ?? 'unknown'}`)
        }

        const activity = response.data.response?.activity
        this.bot.logger.debug(
            this.bot.isMobile,
            LOG_TAG,
            `Edge 活动响应 | offerId=${activity?.a?.offerid ?? 'unknown'}` +
                ` | type=${activity?.type ?? 'unknown'} | quantity=${activity?.q ?? 'unknown'}`
        )

        const validNumber = (value: unknown): number | null => {
            if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value.trim()))) return null
            const number = Number(value)
            return Number.isSafeInteger(number) && number > 0 ? number : null
        }
        const validActivity =
            activity?.a?.offerid === settings.offerId &&
            validNumber(activity?.type) === validNumber(settings.activityType) &&
            validNumber(activity?.type) !== null &&
            validNumber(activity?.q) === 1
        const duplicate = response.data.response?.isDuplicate
        return {
            status: response.status,
            outcome:
                duplicate === true ? 'duplicate' : validActivity && duplicate === false ? 'acknowledged' : 'uncertain',
            cookieNames
        }
    }

    private getPlatformCookieHeader(): { header: string; names: string[] } {
        const target = new URL(URLs.platform.activities)
        const allowedNames = new Set(['MUID', 'MC1'])
        const now = Date.now() / 1000
        const cookiesByName = new Map<string, Cookie>()

        const validCookies = this.bot.cookies.mobile
            .filter(cookie => {
                if (!allowedNames.has(cookie.name)) return false
                if (cookie.expires !== -1 && cookie.expires <= now) return false
                if (cookie.secure && target.protocol !== 'https:') return false

                const domain = cookie.domain.replace(/^\./, '').toLowerCase()
                if (target.hostname !== domain && !target.hostname.endsWith(`.${domain}`)) return false

                const cookiePath = cookie.path || '/'
                if (!target.pathname.startsWith(cookiePath)) return false
                if (
                    target.pathname.length > cookiePath.length &&
                    !cookiePath.endsWith('/') &&
                    target.pathname.charAt(cookiePath.length) !== '/'
                )
                    return false

                return true
            })
            .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0) || b.domain.length - a.domain.length)

        for (const cookie of validCookies) {
            if (!cookiesByName.has(cookie.name)) cookiesByName.set(cookie.name, cookie)
        }

        const cookies = [...cookiesByName.values()]
        return {
            header: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
            names: cookies.map(cookie => cookie.name)
        }
    }

    private logProgress(
        progress: EdgeBrowsingProgressSnapshot,
        acceptedReports: number,
        duplicateReports: number,
        failedReports: number,
        uncertainReports: number
    ): void {
        this.bot.logger.info(
            this.bot.isMobile,
            LOG_TAG,
            this.formatProgress(progress, acceptedReports, duplicateReports, failedReports, uncertainReports)
        )
    }

    private formatProgress(
        progress: EdgeBrowsingProgressSnapshot,
        acceptedReports: number,
        duplicateReports: number,
        failedReports: number,
        uncertainReports: number
    ): string {
        return (
            `Edge 浏览进度 | reportsCompleted=${progress.reportsCompleted ?? 'unknown'}/${progress.reportsTotal}` +
            ` | attemptedReports=${progress.attemptedReports} | progressKnown=${progress.progressKnown}` +
            ` | reportsRemaining=${progress.reportsRemaining ?? 'unknown'}` +
            ` | officialMinutes=${progress.scheduledMinutesCovered ?? 'unknown'}` +
            ` | scheduledMinutesCovered=${progress.scheduledMinutesCovered ?? 'unknown'}/${TARGET_DURATION_MINUTES}` +
            `${progress.nextReportInSeconds === null ? '' : ` | nextReportInSeconds=${progress.nextReportInSeconds}`}` +
            ` | accepted=${acceptedReports} | duplicates=${duplicateReports} | failed=${failedReports} | uncertain=${uncertainReports}` +
            ` | elapsedMinutes=${progress.elapsedMinutes}` +
            ` | estimatedRemainingMinutes=${progress.estimatedRemainingMinutes ?? 'unknown'}`
        )
    }

    private wait(delayMs: number, signal?: AbortSignal): Promise<boolean> {
        if (signal?.aborted) return Promise.resolve(false)
        if (!signal) return this.bot.utils.wait(delayMs).then(() => true)

        return new Promise(resolve => {
            const onAbort = () => {
                clearTimeout(timeout)
                resolve(false)
            }
            const timeout = setTimeout(() => {
                signal.removeEventListener('abort', onAbort)
                resolve(true)
            }, delayMs)

            signal.addEventListener('abort', onAbort, { once: true })
        })
    }
}
