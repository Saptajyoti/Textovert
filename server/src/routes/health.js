const express = require('express')
const { allowedOrigins } = require('../config/cors')

const router = express.Router()
const REQUIRED_ENVIRONMENT = [
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
]

function getReadiness(environment = process.env, origins = allowedOrigins) {
  const missing = REQUIRED_ENVIRONMENT.filter((key) => !environment[key])
  if (!origins.length) missing.push('CLIENT_URL')
  const ready = missing.length === 0
  return {
    ready,
    missing,
    services: {
      supabase: environment.SUPABASE_URL && environment.SUPABASE_PUBLISHABLE_KEY
        ? 'configured'
        : 'not_configured',
      mediaStorage: environment.SUPABASE_SERVICE_ROLE_KEY ? 'configured' : 'not_configured',
    },
  }
}

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'textovert-api' })
})

router.get('/ready', (_req, res) => {
  const readiness = getReadiness()
  res.status(readiness.ready ? 200 : 503).json({
    status: readiness.ready ? 'ready' : 'not_ready',
    services: readiness.services,
    ...(readiness.ready ? {} : { missing: readiness.missing }),
  })
})

module.exports = router
module.exports.getReadiness = getReadiness
