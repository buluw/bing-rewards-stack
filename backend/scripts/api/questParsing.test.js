import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const ReactFunc = require('../../dist/browser/ReactFunc.js').default
const parser = new ReactFunc({ logger: { info() {}, debug() {}, warn() {}, error() {} }, isMobile: false })
const monthly = 'ENWW_pcparent_FY27_BingMonthlyPC_Sep_punchcard'
const starter = 'WW_pcparent_redesign_newuser_onboarding_offer_punchcard'
const element = (tag, props) => ['$', tag, null, props]
const card = (id, children) => ({ href: `/earn/quest/${id}`, instrument: { data: { offerId: id } }, children })
function page(records) {
    const stream = records.map(([id, value]) => `${id}:${JSON.stringify(value)}\n`).join('')
    // Real responses split Flight records across script chunks.
    return [stream.slice(0, 125), stream.slice(125)]
        .map(chunk => `<script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>`)
        .join('')
}

test('monthly card resolves delayed Flight references without taking its neighbour title or points', () => {
    const html = page([
        ['44', [card(starter, { alt: '开始使用 Rewards', children: ['+', '1,320'] }), card(monthly, ['$L5b', '$L5c'])]],
        ['45', { title: '日常任务', children: 'unrelated'.repeat(1000) }],
        ['5b', element('img', { alt: '探索九月' })],
        ['5c', element('div', { children: [element('p', { children: ['+', '50'] }), '2/4 个任务'] })]
    ])
    assert.deepEqual(parser.snapshotQuestList(html), [
        { offerId: starter, title: '开始使用 Rewards', pointProgressMax: 1320, complete: false },
        { offerId: monthly, title: '探索九月', pointProgressMax: 50, complete: false }
    ])
})

test('Chinese and English completed tasks are excluded while incomplete cards remain pending', () => {
    for (const progress of ['4/4 个任务', '4/4 個任務', '4/4 tasks']) {
        const [result] = parser.snapshotQuestList(page([['1', card(monthly, { children: [['+', 50], progress] })]]))
        assert.equal(result.complete, true)
    }
})

test('Flight IDs remain scoped to each page and missing/cyclic references cannot borrow another card', () => {
    const first = page([
        ['1', card(starter, '$L2')],
        ['2', { title: '开始使用', children: ['+', '1,320'] }]
    ])
    const second = page([
        ['1', card(monthly, ['$L2', '$L3', '$L9'])],
        ['2', { title: '九月', children: ['+', '50'] }],
        ['3', '$L3']
    ])
    const results = parser.snapshotQuestList(first, second)
    assert.equal(results[0].pointProgressMax, 1320)
    assert.equal(results[1].pointProgressMax, 50)
    assert.equal(results[1].title, '九月')
})

test('locked monthly child stays unreportable; an unlocked child remains eligible', () => {
    const children = parser.snapshotQuestPage(
        page([
            [
                '1',
                [
                    {
                        offerId: 'ENWW_pcchild3_urlreward_monthly',
                        hash: 'fixture',
                        isCompleted: false,
                        isLocked: false
                    },
                    { offerId: 'ENWW_pcchild4_urlreward_monthly', hash: 'fixture', isCompleted: false, isLocked: true }
                ]
            ]
        ])
    )
    assert.deepEqual(
        children.map(child => child.reportable),
        [true, false]
    )
})
