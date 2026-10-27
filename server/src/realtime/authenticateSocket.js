const { createUserSupabaseClient } = require('../lib/supabase')

async function authenticateSocketToken(token, createClient = createUserSupabaseClient) {
  if (typeof token !== 'string' || token.length > 4096 || token.split('.').length !== 3) {
    throw new Error('A valid Supabase access token is required.')
  }

  const supabase = createClient(token)
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) throw new Error('The Supabase access token is invalid or expired.')

  return { supabase, user: data.user }
}

module.exports = { authenticateSocketToken }
