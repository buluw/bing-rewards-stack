import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export interface DefaultSearchAttempt {
    day: string
    beforeDays: number
    attemptedAt: number
    status: 'pending' | 'confirmed' | 'unconfirmed'
    afterDays?: number
}

export function defaultSearchDay(now: number): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(now))
}

export class DefaultSearchState {
    constructor(private readonly sessionPath: string) {}

    private file(email: string, day: string): string {
        if (!email.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid default search state key')
        const account = createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
        return path.resolve(this.sessionPath, 'default-search', account, 'dse-14', `${day}.json`)
    }

    hasAttempt(email: string, day: string): boolean {
        return fs.existsSync(this.file(email, day))
    }

    reserve(email: string, beforeDays: number, now: number): DefaultSearchAttempt | null {
        const attempt: DefaultSearchAttempt = {
            day: defaultSearchDay(now),
            beforeDays,
            attemptedAt: now,
            status: 'pending'
        }
        const file = this.file(email, attempt.day)
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
        try {
            // Reserve before navigation, including across worker processes and interrupted runs.
            fs.writeFileSync(file, JSON.stringify(attempt) + '\n', { flag: 'wx', mode: 0o600 })
            return attempt
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
            throw error
        }
    }

    finish(email: string, attempt: DefaultSearchAttempt, afterDays?: number): void {
        const file = this.file(email, attempt.day)
        const temp = `${file}.${randomUUID()}.tmp`
        const confirmed = afterDays !== undefined && afterDays > attempt.beforeDays
        const result = { ...attempt, afterDays, status: confirmed ? 'confirmed' : 'unconfirmed' }
        try {
            fs.writeFileSync(temp, JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 })
            fs.renameSync(temp, file)
        } finally {
            if (fs.existsSync(temp)) fs.unlinkSync(temp)
        }
    }
}
