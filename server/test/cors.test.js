const test = require('node:test')
const assert = require('node:assert/strict')
const { allowSocketRequest, corsOptions, isOriginAllowed, normalizeOrigin } = require('../src/config/cors')

test('normalizes a configured origin with a trailing slash', () => {
  const configuredOrigin = normalizeOrigin('https://textovert.example/')
  assert.equal(configuredOrigin, 'https://textovert.example')
  assert.equal(isOriginAllowed('https://textovert.example', [configuredOrigin]), true)
})

test('rejects CLIENT_URL entries that include a path or use a non-HTTP protocol', () => {
  assert.throws(() => normalizeOrigin('https://textovert.example/chat'), /without paths/)
  assert.throws(() => normalizeOrigin('file://textovert.example'), /HTTP\(S\) origins/)
  assert.throws(() => normalizeOrigin('https://user:password@textovert.example'), /without paths/)
})

test('allows requests without a browser Origin header for token-authenticated clients', () => {
  assert.equal(isOriginAllowed(undefined), true)
  let result
  allowSocketRequest({ headers: {} }, (_error, allowed) => {
    result = allowed
  })
  assert.equal(result, true)
})

test('applies the exact configured origin allow-list to Socket.IO handshakes', () => {
  const configuredOrigin = 'https://textovert.example'
  assert.equal(isOriginAllowed(configuredOrigin, [configuredOrigin]), true)
  assert.equal(isOriginAllowed(`${configuredOrigin}.attacker.example`, [configuredOrigin]), false)

  let result
  allowSocketRequest({ headers: { origin: configuredOrigin } }, (error, allowed) => {
    assert.equal(error, null)
    result = allowed
  }, [configuredOrigin])
  assert.equal(result, true)

  allowSocketRequest({ headers: { origin: 'https://untrusted.example' } }, (error, allowed) => {
    assert.equal(error, null)
    result = allowed
  }, [configuredOrigin])
  assert.equal(result, false)
})

test('reports disallowed HTTP origins as forbidden', () => {
  corsOptions().origin('https://untrusted.example', (error, allowed) => {
    assert.equal(allowed, undefined)
    assert.equal(error.status, 403)
  })
})
