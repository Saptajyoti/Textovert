function configuredOrigins() {
  const configured = process.env.CLIENT_URL
  if (configured) {
    return configured.split(',').map((origin) => origin.trim()).filter(Boolean)
  }
  return process.env.NODE_ENV === 'production' ? [] : ['http://localhost:5173']
}

const allowedOrigins = configuredOrigins()

function isOriginAllowed(origin, origins = allowedOrigins) {
  return !origin || origins.includes(origin)
}

function allowSocketRequest(req, callback, origins = allowedOrigins) {
  callback(null, isOriginAllowed(req.headers.origin, origins))
}

function corsOptions() {
  return {
    credentials: true,
    origin(origin, callback) {
      if (isOriginAllowed(origin)) {
        callback(null, true)
        return
      }
      const error = new Error('Origin is not allowed by CORS')
      error.status = 403
      callback(error)
    },
  }
}

module.exports = { allowedOrigins, allowSocketRequest, corsOptions, isOriginAllowed }
