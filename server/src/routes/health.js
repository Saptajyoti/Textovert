const express = require('express')
const { allowedOrigins } = require('../config/cors')

const router = express.Router()

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'textovert-api' })
})

router.get('/ready', (_req, res) => {
  const missing = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY'].filter((key) => !process.env[key])
  if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
    missing.push('CLIENT_URL')
  }
  const ready = missing.length === 0
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    services: { supabase: ready ? 'configured' : 'not_configured' },
    ...(ready ? {} : { missing }),
  })
})

module.exports = router
