import { Impit } from 'impit'
import { envStrFrom } from '../env.js'
import { readStoredSession } from './sessionStore.js'

// Mainland Bing redirects www to cn. Query the regional endpoint directly so
// redirects stay disabled and cookies never have to cross to another host.
const BALANCE_URL = 'https://cn.bing.com/rewards/panelflyout/getuserinfo?channel=BingFlyout&partnerId=BingRewards'
const validBalance = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const failure = (message, statusCode = 502) => Object.assign(new Error(message), { statusCode })

export function cookieHeader(cookies, target = BALANCE_URL, now = Date.now()) {
    const url = new URL(target)
    return cookies
        .filter(cookie => {
            if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string') return false
            if (/[;\r\n]/.test(cookie.name + cookie.value)) return false
            const domain = String(cookie.domain || '').toLowerCase()
            const hostMatch = domain.startsWith('.')
                ? url.hostname === domain.slice(1) || url.hostname.endsWith(domain)
                : url.hostname === domain
            const cookiePath = cookie.path || '/'
            const pathMatch =
                url.pathname === cookiePath ||
                url.pathname.startsWith(cookiePath.endsWith('/') ? cookiePath : cookiePath + '/')
            const unexpired = cookie.expires == null || cookie.expires === -1 || cookie.expires > now / 1000
            return hostMatch && pathMatch && unexpired && (!cookie.secure || url.protocol === 'https:')
        })
        .map(cookie => `${cookie.name}=${cookie.value}`)
        .join('; ')
}

export function balanceFromPayload(payload) {
    const user = payload?.userInfo
    const status = payload?.flyoutResult?.userStatus
    if (payload?.isError || user?.errorCode || user?.isRewardsUser !== true || status?.isRewardsUser !== true) {
        throw failure('登录会话已失效或微软未返回账号信息，请先完成正常登录。', 409)
    }
    const balance = status.availablePoints ?? user.balance
    if (!validBalance(balance)) throw failure('微软未返回有效余额，已保留上次记录。')
    const counters = status.counters || {}
    const pcSearchItem = (counters.PCSearch ?? counters.pcSearch ?? [])[0]
    const mobileSearchItem = (counters.MobileSearch ?? counters.mobileSearch ?? [])[0]
    const dailyPointItem = (counters.DailyPoint ?? counters.dailyPoint ?? [])[0]
    const parsedCounters = {
        pcSearch: typeof pcSearchItem?.pointProgress === 'number' ? pcSearchItem.pointProgress : null,
        pcSearchMax: typeof pcSearchItem?.pointProgressMax === 'number' ? pcSearchItem.pointProgressMax : null,
        mobileSearch: typeof mobileSearchItem?.pointProgress === 'number' ? mobileSearchItem.pointProgress : null,
        dailyPoint: typeof dailyPointItem?.pointProgress === 'number' ? dailyPointItem.pointProgress : null
    }
    return { balance, counters: parsedCounters }
}

export function balanceProxy(index, env) {
    const prefix = `ACCOUNT_${index}_PROXY_`
    const raw = envStrFrom(env, prefix + 'URL')
    if (!raw) return undefined
    // Honour the account's route even if normal API proxying was disabled.
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`)
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol))
        throw failure('账号代理协议不支持余额查询。', 400)
    const port = envStrFrom(env, prefix + 'PORT')
    if (port && port !== '0') url.port = port
    const user = envStrFrom(env, prefix + 'USERNAME')
    const password = envStrFrom(env, prefix + 'PASSWORD')
    if (user) url.username = user
    if (password) url.password = password
    return url.toString()
}

export async function querySavedBalance({ session, proxyUrl, createClient = options => new Impit(options) }) {
    const cookies = cookieHeader(session.storageState.cookies)
    if (!cookies) throw failure('没有可用的必应登录会话，请先完成正常登录。', 409)
    const headers = { Accept: 'application/json', Cookie: cookies, Referer: 'https://cn.bing.com/' }
    for (const [name, value] of Object.entries(session.fingerprint?.headers || {})) {
        if (/^(user-agent|accept-language|sec-ch-ua(?:-mobile|-platform)?)$/i.test(name) && typeof value === 'string')
            headers[name] = value
    }
    try {
        const client = createClient({ browser: 'chrome', proxyUrl, timeout: 15000, followRedirects: false })
        // No browser, login, searches, reportActivity or session/database writes.
        const response = await client.fetch(BALANCE_URL, { method: 'GET', headers, redirect: 'error' })
        if (!response.ok) throw failure('微软余额查询失败，已保留上次记录。')
        return balanceFromPayload(await response.json())
    } catch (error) {
        if (error.statusCode) throw error
        // Native network errors can contain URLs/proxy credentials.
        throw failure('余额查询超时、网络异常或会话失效，已保留上次记录。')
    }
}

export function createBalanceReader({
    projectRoot,
    env = process.env,
    readSession = readStoredSession,
    request = querySavedBalance,
    now = Date.now
}) {
    const cache = new Map()
    const pending = new Map()
    return async function readBalance(account, sessionPath) {
        const key = account.email.toLowerCase()
        const cached = cache.get(key)
        if (cached && now() - Date.parse(cached.checkedAt) < 60000) return cached
        if (pending.has(key)) return pending.get(key)
        const work = (async () => {
            const session = readSession(projectRoot, sessionPath, account.email)
            if (!session) throw failure('未找到此账号的已保存会话，请先完成正常登录。', 409)
            const queryResult = await request({ session, proxyUrl: balanceProxy(account.index, env) })
            const balance = typeof queryResult === 'object' && queryResult !== null ? queryResult.balance : queryResult
            const counters = typeof queryResult === 'object' && queryResult !== null ? queryResult.counters : null
            if (!validBalance(balance)) throw failure('查询结果无有效余额，已保留上次记录。')
            const result = {
                email: account.email,
                accountIndex: account.index,
                balance,
                counters,
                checkedAt: new Date(now()).toISOString()
            }
            cache.set(key, result)
            return result
        })()
        pending.set(key, work)
        try {
            return await work
        } finally {
            pending.delete(key)
        }
    }
}
