function normalizeOrigin(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('CLIENT_URL must contain comma-separated absolute HTTP(S) origins.')
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('CLIENT_URL must contain comma-separated HTTP(S) origins without paths or query strings.')
  }
  return url.origin
}

function safeOriginLabel(origin) {
  try {
    return normalizeOrigin(origin)
  } catch {
    return 'invalid-origin'
  }
}

function configuredOrigins() {
  const configured = process.env.CLIENT_URL
  if (configured) {
    return configured.split(',').map((origin) => normalizeOrigin(origin.trim())).filter(Boolean)
  }
  return []
}

const allowedOrigins = configuredOrigins()

function isOriginAllowed(origin, origins = allowedOrigins) {
  if (!origin) return true
  try {
    return origins.includes(normalizeOrigin(origin))
  } catch {
    return false
  }
}

function allowSocketRequest(req, callback, origins = allowedOrigins) {
  const origin = req.headers.origin
  const allowed = isOriginAllowed(origin, origins)
  if (!allowed) console.warn('[cors] Rejected Socket.IO origin:', safeOriginLabel(origin))
  callback(null, allowed)
}

function corsOptions() {
  return {
    credentials: true,
    origin(origin, callback) {
      if (isOriginAllowed(origin)) {
        callback(null, true)
        return
      }
      console.warn('[cors] Rejected HTTP origin:', safeOriginLabel(origin))
      const error = new Error('Origin is not allowed by CORS')
      error.status = 403
      callback(error)
    },
  }
}

module.exports = { allowedOrigins, allowSocketRequest, corsOptions, isOriginAllowed, normalizeOrigin }
