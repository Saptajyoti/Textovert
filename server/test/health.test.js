const test = require('node:test')
const assert = require('node:assert/strict')
const { getReadiness } = require('../src/routes/health')

const configuredEnvironment = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'public-key-value',
  SUPABASE_SERVICE_ROLE_KEY: 'server-secret-value',
}

test('readiness requires Supabase, server-side media storage, and a browser origin allowlist', () => {
  const readiness = getReadiness(configuredEnvironment, ['https://client.example'])

  assert.equal(readiness.ready, true)
  assert.deepEqual(readiness.missing, [])
  assert.deepEqual(readiness.services, {
    supabase: 'configured',
    mediaStorage: 'configured',
  })
  assert.equal(JSON.stringify(readiness).includes('server-secret-value'), false)
})

test('readiness identifies absent private-storage credentials without exposing secret values', () => {
  const environment = { ...configuredEnvironment, SUPABASE_SERVICE_ROLE_KEY: '' }
  const readiness = getReadiness(environment, ['https://client.example'])

  assert.equal(readiness.ready, false)
  assert.deepEqual(readiness.missing, ['SUPABASE_SERVICE_ROLE_KEY'])
  assert.deepEqual(readiness.services, {
    supabase: 'configured',
    mediaStorage: 'not_configured',
  })
})

test('readiness requires an explicit allowed browser origin in every environment', () => {
  const readiness = getReadiness(configuredEnvironment, [])

  assert.equal(readiness.ready, false)
  assert.deepEqual(readiness.missing, ['CLIENT_URL'])
})
