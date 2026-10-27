function notFound(_req, res) {
  res.status(404).json({ error: 'Route not found.' })
}

function errorHandler(error, _req, res, next) {
  console.error(`[${new Date().toISOString()}] ${error.stack || error.message}`)
  if (res.headersSent) {
    next(error)
    return
  }
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
    ? error.status
    : 500
  res.status(status).json({
    error: status === 500 ? 'An unexpected server error occurred.' : error.message,
  })
}

module.exports = { notFound, errorHandler }
