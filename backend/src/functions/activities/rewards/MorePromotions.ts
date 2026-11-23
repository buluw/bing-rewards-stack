import { BaseActivity } from '../BaseActivity'
import type { BasePromotion, DashboardData } from '../../../interface/DashboardData'
import { PromotionActivityRunner } from './PromotionActivityRunner'

export class MorePromotions extends BaseActivity {
    public async run(data: DashboardData): Promise<void> {
        const promotions = [
            ...new Map(
                [
                    ...(data.dashboard.morePromotions ?? []),
                    ...(data.dashboard.morePromotionsWithoutPromotionalItems ?? [])
                ]
                    .filter(Boolean)
                    .map(promotion => [promotion.offerId, promotion as BasePromotion] as const)
            ).values()
        ]

        const snapshots = [this.bot.reactSnapshot, this.bot.reactSnapshots?.desktop, this.bot.reactSnapshots?.mobile];
        for (const snapshot of snapshots) {
            if (!snapshot?.offers) continue;
            for (const offer of snapshot.offers) {
                if (offer && !offer.isCompleted && offer.reportable && offer.points > 0 && !offer.offerId.includes('pcparent') && !offer.offerId.includes('DailySet')) {
                    if (!promotions.some(p => p.offerId === offer.offerId)) {
                        promotions.push({
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
                        } as unknown as BasePromotion);
                    }
                }
            }
        }

        const pending = promotions.filter(promotion => this.isActionable(promotion))
        if (!pending.length) {
            this.bot.logger.info(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                '所有"更多推广"项目已完成'
            )
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'MORE-PROMOTIONS',
            `开始解决"更多推广"项目 | remaining=${pending.length}`
        )
        await new PromotionActivityRunner(this.bot).run(pending)
        this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', '"更多推广"项目处理完毕')
    }

    private isActionable(promotion: BasePromotion): boolean {
        if (promotion.complete || promotion.pointProgressMax <= 0) return false
        if (promotion.exclusiveLockedFeatureStatus === 'locked' || !promotion.promotionType) return false
        if (promotion.priority < 0 && promotion.exclusiveLockedFeatureStatus !== 'unlocked') return false
        return true
    }

}
