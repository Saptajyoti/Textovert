const { createClient } = require('@supabase/supabase-js')

function createUserSupabaseClient(accessToken) {
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = process.env
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    const error = new Error('Authentication service is not configured.')
    error.status = 503
    throw error
  }

  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

module.exports = { createUserSupabaseClient }
