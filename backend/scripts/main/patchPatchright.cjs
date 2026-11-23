// Reproducible, narrow fix for Patchright 1.61.1's reused TLS socket crash.
// TLS validation remains unchanged; securityDetails is optional metadata.
const fs = require('node:fs')
const path = require('node:path')

const statement = 'const peerCertificate = socket.getPeerCertificate();'
const guard = '\n            if (!peerCertificate?.subject || !peerCertificate?.issuer) return;'

function patchSource(source) {
    if (source.includes(statement + guard)) return source
    if (
        source.split(statement).length !== 2 ||
        !source.includes('subjectName: peerCertificate.subject.CN') ||
        !source.includes('issuer: peerCertificate.issuer.CN')
    ) {
        throw new Error('Unsupported Patchright TLS implementation; review the dependency before building')
    }
    return source.replace(statement, statement + guard)
}

function patchInstalled(projectRoot = path.resolve(__dirname, '../..')) {
    const root = path.join(projectRoot, 'node_modules/patchright-core')
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
    if (version !== '1.61.1') throw new Error('Review the TLS patch for Patchright ' + version)
    const file = path.join(root, 'lib/coreBundle.js')
    const before = fs.readFileSync(file, 'utf8')
    const after = patchSource(before)
    if (after !== before) fs.writeFileSync(file, after, 'utf8')
}

if (require.main === module) patchInstalled()
module.exports = { patchSource, patchInstalled }
