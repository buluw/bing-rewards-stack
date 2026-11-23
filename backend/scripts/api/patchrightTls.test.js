import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const { patchSource } = require('../main/patchPatchright.cjs')
const bundle = fs.readFileSync(new URL('../../node_modules/patchright-core/lib/coreBundle.js', import.meta.url), 'utf8')
const original = bundle.replace('\n            if (!peerCertificate?.subject || !peerCertificate?.issuer) return;', '')

function capture(source, certificate) {
    const start = source.indexOf('const captureSecurityDetails = (socket) => {')
    const end = source.indexOf('\n          };', start)
    assert.ok(start >= 0 && end > start)
    const sandbox = { certificate }
    vm.runInNewContext(
        `let securityDetails;
         class TLSSocket { getPeerCertificate() { return certificate; } getProtocol() { return 'TLSv1.3'; } }
         const import_tls3 = { TLSSocket };
         ${source.slice(start, end + 13)}
         captureSecurityDetails(new TLSSocket());
         globalThis.result = securityDetails;`,
        sandbox
    )
    return sandbox.result
}

test('reproduces the real reused-socket null certificate crash', () => {
    assert.throws(() => capture(original, null), /reading 'subject'/)
})

test('patched dependency accepts missing certificate metadata without disabling TLS', () => {
    for (const certificate of [null, {}, { subject: { CN: 'example.invalid' } }, { issuer: {} }]) {
        assert.equal(capture(patchSource(original), certificate), undefined)
    }
    assert.equal(
        patchSource(original).includes('rejectUnauthorized: false'),
        original.includes('rejectUnauthorized: false')
    )
})

test('patched dependency preserves complete certificate details and is idempotent', () => {
    const source = patchSource(original)
    assert.equal(patchSource(source), source)
    const details = capture(source, {
        subject: { CN: 'example.invalid' },
        issuer: { CN: 'Test CA' },
        valid_from: '2026-01-01',
        valid_to: '2027-01-01'
    })
    assert.equal(details.subjectName, 'example.invalid')
    assert.equal(details.issuer, 'Test CA')
    assert.equal(details.protocol, 'TLSv1.3')
    assert.equal(details.validFrom, Date.parse('2026-01-01') / 1000)
})

test('unknown dependency layouts fail the build instead of silently skipping the fix', () => {
    assert.throws(() => patchSource('different implementation'), /Unsupported Patchright/)
    assert.throws(() => patchSource(original + original), /Unsupported Patchright/)
})
