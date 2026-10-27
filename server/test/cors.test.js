const test = require('node:test')
const assert = require('node:assert/strict')
const { allowSocketRequest, corsOptions, isOriginAllowed } = require('../src/config/cors')

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
