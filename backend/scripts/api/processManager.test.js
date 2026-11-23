import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { ProcessManager } from './processManager.js'

test('a crashed child preserves its exact run identity and confirmed partial gains', async () => {
    const lines = [
        '[10/25/2026, 9:00:00 AM] [test] [INFO] MAIN [ACCOUNT-START] 开始处理账户: a@test.invalid | geoLocale: CN | locale: zh-CN',
        '[10/25/2026, 9:00:39 AM] [test] [INFO] MOBILE [URL-REWARD] UrlReward 完成 | offerId=test | pointsGained=10 | currentBalance=110'
    ]
    const manager = new ProcessManager({
        command: process.execPath,
        args: ['-e', `console.log(${JSON.stringify(lines.join('\n'))});process.exitCode=1`]
    })
    const exit = once(manager, 'exit')
    const info = manager.start()
    await exit
    const status = manager.getStatus()
    assert.equal(status.state, 'idle')
    assert.equal(status.lastExit.code, 1)
    assert.equal(status.lastExit.startedAt, info.startedAt)
    assert.equal(status.lastExit.cancelled, false)
    assert.equal(status.run.accounts[0].live.gained, 10)
    assert.equal(status.run.accounts[0].live.balance, 110)
    assert.equal(status.run.accounts[0].success, null)
})

test('manual stop remains identifiable even if the child exits with a crash code', async () => {
    const manager = new ProcessManager({ command: process.execPath })
    manager.state = 'running'
    manager.startedAt = '2026-10-25T01:00:00.000Z'
    manager._killTree = () => setImmediate(() => manager._finalize(1, null))
    await manager.stop()
    assert.equal(manager.lastExit.cancelled, true)
    assert.equal(manager.lastExit.startedAt, '2026-10-25T01:00:00.000Z')
})
