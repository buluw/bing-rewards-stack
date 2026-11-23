import { BaseActivity } from '../BaseActivity'
import type { BasePromotion, DashboardData } from '../../../interface/DashboardData'
import { PromotionActivityRunner } from './PromotionActivityRunner'

export class DailySet extends BaseActivity {
    public async run(data: DashboardData): Promise<void> {
        const today = this.bot.utils.getFormattedDate()
        const pending: BasePromotion[] =
            data.dashboard.dailySetPromotions[today]?.filter(item => !item.complete && item.pointProgressMax > 0) ?? []

        // 1. 从接口树中补齐中国区专属 DailySet_ZHCN 任务
        const allPromos = Object.values(data.dashboard.dailySetPromotions ?? {}).flat()
        for (const item of allPromos) {
            if (item && !item.complete && item.pointProgressMax > 0 && String(item.offerId || item.name).includes('DailySet_ZHCN')) {
                if (!pending.some(p => p.offerId === item.offerId)) pending.push(item)
            }
        }

        // 2. 从网页 React 页面快照中补齐中国区专属 DailySet_ZHCN 任务
        const snapshots = [this.bot.reactSnapshot, this.bot.reactSnapshots?.desktop, this.bot.reactSnapshots?.mobile]
        for (const snapshot of snapshots) {
            if (!snapshot?.offers) continue
            for (const offer of snapshot.offers) {
                if (offer && offer.offerId?.includes('DailySet_ZHCN') && !offer.isCompleted && offer.reportable) {
                    if (!pending.some(p => p.offerId === offer.offerId)) {
                        pending.push({
                            offerId: offer.offerId,
                            name: offer.offerId,
                            title: offer.title,
                            promotionType: 'urlreward',
                            hash: offer.hash,
                            pointProgressMax: offer.points,
                            complete: offer.isCompleted,
                            destinationUrl: offer.destination,
                            activityType: String(offer.activityType ?? 11),
                            isRewardable: true,
                            priority: 1,
                        } as unknown as BasePromotion)
                    }
                }
            }
        }

        if (!pending.length) {
            this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', '所有"每日任务"项目已完成')
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'DAILY-SET',
            '开始解决"每日任务"项目 | remaining=' + pending.length
        )
        await new PromotionActivityRunner(this.bot).run(pending)
        this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', '"每日任务"项目处理完毕')
    }
}