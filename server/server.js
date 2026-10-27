require('dotenv').config()

const http = require('node:http')
const app = require('./src/app')
const { attachSockets } = require('./src/sockets')

const port = Number(process.env.PORT || 5000)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.')
}

const server = http.createServer(app)
const io = attachSockets(server)
app.set('io', io)

server.listen(port, '0.0.0.0', () => {
  console.info(`[api] Textovert listening on port ${port}`)
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY) {
    console.warn('[api] Supabase is not configured; readiness will report not_ready.')
  }
})

let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.info(`[api] ${signal} received; closing server`)
  const forceExit = setTimeout(() => {
    console.error('[api] Graceful shutdown timed out.')
    process.exit(1)
  }, 10_000)
  forceExit.unref()
  io.close(() => {
    clearTimeout(forceExit)
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
