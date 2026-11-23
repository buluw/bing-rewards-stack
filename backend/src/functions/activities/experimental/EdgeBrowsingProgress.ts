import { performance } from 'node:perf_hooks'

export interface EdgeBrowsingProgressSnapshot {
    attemptedReports: number
    reportsCompleted: number | null
    reportsTotal: number
    reportsRemaining: number | null
    scheduledMinutesCovered: number | null
    progressKnown: boolean
    nextReportInSeconds: number | null
    elapsedMinutes: number
    estimatedRemainingMinutes: number | null
}

export class EdgeBrowsingProgress {
    private readonly startedAt: number

    constructor(
        private readonly targetMinutes: number,
        private readonly intervalMinutes: number,
        private readonly delays: readonly number[],
        private readonly now: () => number = () => performance.now()
    ) {
        this.startedAt = now()
    }

    public get reportsTotal(): number {
        return Math.ceil(this.targetMinutes / this.intervalMinutes)
    }

    public snapshot(
        attemptedReports: number,
        confirmedMinutes: number | null,
        progressKnown: boolean
    ): EdgeBrowsingProgressSnapshot {
        const remaining =
            confirmedMinutes === null ? null : Math.ceil((this.targetMinutes - confirmedMinutes) / this.intervalMinutes)
        const nextDelay = progressKnown && remaining !== 0 ? this.delays[attemptedReports] : undefined

        return {
            attemptedReports,
            reportsCompleted:
                confirmedMinutes === null
                    ? null
                    : confirmedMinutes === this.targetMinutes
                      ? this.reportsTotal
                      : Math.floor(confirmedMinutes / this.intervalMinutes),
            reportsTotal: this.reportsTotal,
            reportsRemaining: remaining,
            // Compatibility field: only official minutes, never attempted reports multiplied by five.
            scheduledMinutesCovered: confirmedMinutes,
            progressKnown,
            nextReportInSeconds: nextDelay === undefined ? null : this.round(nextDelay / 1000),
            elapsedMinutes: this.toMinutes(this.now() - this.startedAt),
            estimatedRemainingMinutes:
                progressKnown && confirmedMinutes !== null ? this.round(this.targetMinutes - confirmedMinutes) : null
        }
    }

    public delayBeforeReport(reportNumber: number): number {
        return this.delays[reportNumber - 1] ?? 0
    }

    private toMinutes(milliseconds: number): number {
        return this.round(milliseconds / 60_000)
    }

    private round(value: number): number {
        return Math.round(value * 10) / 10
    }
}
