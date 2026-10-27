const { createUserSupabaseClient } = require('../lib/supabase')

async function requireAuth(req, res, next) {
  const token = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) {
    res.status(401).json({ error: 'A valid bearer token is required.' })
    return
  }

  try {
    const supabase = createUserSupabaseClient(token)
    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data.user) {
      res.status(401).json({ error: 'The access token is invalid or expired.' })
      return
    }
    req.user = data.user
    req.supabase = supabase
    next()
  } catch (error) {
    if (error.status === 503) {
      res.status(503).json({ error: error.message })
      return
    }
    next(error)
  }
}

module.exports = { requireAuth }
