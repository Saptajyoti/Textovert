import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AuthContext } from './authContext.js'
import { supabase } from '../lib/supabase.js'

const profileRequests = new Map()

function profileErrorMessage(error) {
  if (error.code === '23505') {
    return 'That username is already taken. Choose another username to finish setting up your account.'
  }
  return error.message || 'Your account is signed in, but profile setup could not be completed. Please try again.'
}

async function createOrGetProfile(user, requestedUsername) {
  if (!supabase) throw new Error('Supabase is not configured. Add the client environment variables and restart Vite.')

  const { data: existingProfile, error: lookupError } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('id', user.id)
    .maybeSingle()

  if (lookupError) throw new Error(profileErrorMessage(lookupError))
  if (existingProfile) return existingProfile

  const username = (requestedUsername || user.user_metadata?.username || '').trim().toLowerCase()
  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    throw new Error('Choose a username between 3 and 32 characters using letters, numbers, or underscores.')
  }

  const { data: profile, error: insertError } = await supabase
    .from('profiles')
    .insert({ id: user.id, username, display_name: username })
    .select('id, username')
    .single()

  if (!insertError) return profile

  if (insertError.code === '23505') {
    const { data: concurrentProfile, error: concurrentLookupError } = await supabase
      .from('profiles')
      .select('id, username')
      .eq('id', user.id)
      .maybeSingle()
    if (!concurrentLookupError && concurrentProfile) return concurrentProfile
  }

  throw new Error(profileErrorMessage(insertError))
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [authLoading, setAuthLoading] = useState(Boolean(supabase))
  const [profileStatus, setProfileStatus] = useState('idle')
  const [profileError, setProfileError] = useState('')
  const activeUserId = useRef(null)

  const ensureProfile = useCallback(async (user, username) => {
    if (!user) throw new Error('Sign in before setting up your profile.')

    let request = profileRequests.get(user.id)
    if (!request) {
      request = createOrGetProfile(user, username)
      profileRequests.set(user.id, request)
    }

    if (activeUserId.current === user.id) {
      setProfileStatus('loading')
      setProfileError('')
    }
    try {
      const profile = await request
      if (activeUserId.current === user.id) setProfileStatus('ready')
      return profile
    } catch (error) {
      if (activeUserId.current === user.id) {
        setProfileStatus('error')
        setProfileError(error.message)
      }
      throw error
    } finally {
      if (profileRequests.get(user.id) === request) profileRequests.delete(user.id)
    }
  }, [])

  useEffect(() => {
    if (!supabase) return undefined

    const pendingProfileTimers = new Set()
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      activeUserId.current = nextSession?.user?.id ?? null
      setSession(nextSession)
      setAuthLoading(false)
      if (!nextSession?.user) {
        setProfileStatus('idle')
        setProfileError('')
        return
      }

      setProfileStatus('loading')
      const timer = window.setTimeout(() => {
        pendingProfileTimers.delete(timer)
        ensureProfile(nextSession.user).catch((error) => {
          console.error('Textovert could not finish profile setup:', error.message)
        })
      }, 0)
      pendingProfileTimers.add(timer)
    })

    return () => {
      subscription.unsubscribe()
      pendingProfileTimers.forEach((timer) => window.clearTimeout(timer))
    }
  }, [ensureProfile])

  const signOut = useCallback(async () => {
    if (!supabase) throw new Error('Supabase is not configured.')
    const { error } = await supabase.auth.signOut()
    if (error) throw error
  }, [])

  const value = useMemo(() => ({
    session,
    user: session?.user ?? null,
    authLoading,
    profileStatus,
    profileError,
    ensureProfile,
    signOut,
  }), [session, authLoading, profileStatus, profileError, ensureProfile, signOut])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
