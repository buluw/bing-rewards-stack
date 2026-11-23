import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
    balanceFromPayload,
    balanceProxy,
    cookieHeader,
    createBalanceReader,
    querySavedBalance
} from './balanceReader.js'
import { readStoredSession } from './sessionStore.js'

const cookie = { name: 'fixture', value: 'secret', domain: '.bing.com', path: '/', expires: -1, secure: true }
const session = {
    storageState: { cookies: [cookie] },
    fingerprint: { headers: { 'user-agent': 'fixture', authorization: 'must-not-copy' } }
}
const payload = balance => ({
    userInfo: { isRewardsUser: true },
    flyoutResult: { userStatus: { isRewardsUser: true, availablePoints: balance } }
})

test('valid zero is preserved; missing, malformed or signed-out responses never become zero', () => {
    assert.equal(balanceFromPayload(payload(973)).balance, 973)
    assert.equal(balanceFromPayload(payload(0)).balance, 0)
    for (const value of [null, undefined, '', '973', -1, 1.5, NaN])
        assert.throws(() => balanceFromPayload(payload(value)))
    assert.throws(() => balanceFromPayload({ ...payload(0), isError: true }))
    assert.throws(() => balanceFromPayload({ userInfo: { balance: 0, isRewardsUser: false } }))
})

test('cookies are scoped to the exact target domain, path and expiry', () => {
    const cookies = [
        cookie,
        { ...cookie, domain: 'evilbing.com' },
        { ...cookie, domain: 'rewards.bing.com' },
        { ...cookie, domain: 'www.bing.com' },
        { ...cookie, expires: 1 },
        { ...cookie, path: '/rewards/panel' },
        { ...cookie, name: 'bad\r\n' }
    ]
    assert.equal(cookieHeader(cookies), 'fixture=secret')
    assert.equal(cookieHeader([cookie], 'http://www.bing.com/'), '')
})

test('balance query sends one read-only GET and never follows redirects or copies authorization', async () => {
    let calls = 0
    const balance = await querySavedBalance({
        session,
        proxyUrl: 'http://proxy.test:8080',
        createClient: options => {
            assert.equal(options.followRedirects, false)
            assert.equal(options.proxyUrl, 'http://proxy.test:8080')
            return {
                fetch: async (url, init) => {
                    calls++
                    assert.equal(new URL(url).hostname, 'cn.bing.com')
                    assert.equal(new URL(url).pathname, '/rewards/panelflyout/getuserinfo')
                    assert.equal(init.method, 'GET')
                    assert.equal(init.redirect, 'error')
                    assert.equal(init.headers.authorization, undefined)
                    assert.equal(init.body, undefined)
                    return { ok: true, json: async () => payload(973) }
                }
            }
        }
    })
    assert.equal(typeof balance === 'object' ? balance.balance : balance, 973)
    assert.equal(calls, 1)
})

test('transport error text containing credentials never reaches the caller', async () => {
    await assert.rejects(
        querySavedBalance({
            session,
            createClient: () => ({
                fetch: () => {
                    throw new Error('proxy://password@host')
                }
            })
        }),
        error => !error.message.includes('password') && error.statusCode === 502
    )
})

test('proxy follows the selected account, including credentials and port', () => {
    const result = new URL(
        balanceProxy(2, {
            ACCOUNT_2_PROXY_URL: 'http://proxy.test',
            ACCOUNT_2_PROXY_PORT: '8888',
            ACCOUNT_2_PROXY_USERNAME: 'reader',
            ACCOUNT_2_PROXY_PASSWORD: 'test-password',
            ACCOUNT_1_PROXY_URL: 'http://other.test'
        })
    )
    assert.equal(result.host, 'proxy.test:8888')
    assert.equal(result.username, 'reader')
    assert.equal(balanceProxy(3, {}), undefined)
})

test('concurrent refreshes coalesce; accounts and cached balances stay isolated; errors do not cache zero', async () => {
    let calls = 0
    let time = Date.parse('2026-09-20T10:00:00Z')
    let fail = false
    const read = createBalanceReader({
        projectRoot: '.',
        env: {},
        now: () => time,
        readSession: (_root, _path, email) => ({ email }),
        request: async session => {
            calls++
            if (fail) throw new Error('offline')
            return session.session.email === 'a@test.invalid' ? 973 : 715
        }
    })
    const a = { index: 1, email: 'a@test.invalid' }
    const b = { index: 2, email: 'b@test.invalid' }
    const results = await Promise.all([read(a, 'sessions'), read(a, 'sessions')])
    assert.equal(calls, 1)
    assert.equal(results[0].balance, 973)
    assert.deepEqual(results[0], results[1])
    assert.equal((await read(b, 'sessions')).balance, 715)
    time += 61000
    fail = true
    await assert.rejects(read(a, 'sessions'))
    fail = false
    assert.equal((await read(a, 'sessions')).balance, 973)
    assert.equal(calls, 4)
})

test('reading sessions never modifies the DB or returns a different account', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-session-test-'))
    const file = path.join(dir, 'sessions.db')
    try {
        const db = new DatabaseSync(file)
        db.exec(
            'CREATE TABLE sessions(email TEXT,platform TEXT,storage_state TEXT,fingerprint TEXT,updated_at INTEGER)'
        )
        db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(
            'a@test.invalid',
            'desktop',
            JSON.stringify(session.storageState),
            null,
            1
        )
        db.close()
        const before = fs.readFileSync(file)
        assert.equal(readStoredSession(dir, '.', 'A@test.invalid').storageState.cookies[0].value, 'secret')
        assert.equal(readStoredSession(dir, '.', 'b@test.invalid'), null)
        assert.deepEqual(fs.readFileSync(file), before)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
