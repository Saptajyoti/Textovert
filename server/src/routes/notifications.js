const express = require('express')
const rateLimit = require('express-rate-limit')
const { requireAuth } = require('../middleware/requireAuth')
const { createServiceRoleClient } = require('../lib/supabase')
const { getPublicKey, isWebPushConfigured } = require('../lib/webPush')
const { isUuid } = require('../realtime/messaging')

const router = express.Router()
const DEFAULT_PREFERENCES = {
  in_app_enabled: true,
  browser_enabled: false,
  sound_enabled: false,
  messages_enabled: true,
  invitations_enabled: true,
  preview_enabled: false,
  while_open_enabled: false,
}
const PREFERENCE_KEYS = new Set(Object.keys(DEFAULT_PREFERENCES))
const PUSH_ENDPOINT_HOSTS = [
  (host) => host === 'fcm.googleapis.com',
  (host) => host === 'updates.push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com'),
  (host) => host.endsWith('.notify.windows.com'),
  (host) => host === 'web.push.apple.com',
]

router.use(requireAuth)

const subscriptionRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => req.user.id,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many push subscription updates. Try again later.' }),
})

function isValidPushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && PUSH_ENDPOINT_HOSTS.some((isAllowedHost) => isAllowedHost(url.hostname))
  } catch {
    return false
  }
}

function isValidPushKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(value)
}

router.get('/', async (req, res, next) => {
  try {
    const { data: storedPreferences, error: preferencesError } = await req.supabase
      .from('notification_preferences')
      .select('in_app_enabled, messages_enabled, invitations_enabled')
      .eq('user_id', req.user.id)
      .maybeSingle()
    if (preferencesError) throw preferencesError
    const preferences = { ...DEFAULT_PREFERENCES, ...(storedPreferences || {}) }
    if (!preferences.in_app_enabled ||
      (!preferences.messages_enabled && !preferences.invitations_enabled)) {
      res.json({ notifications: [], totalCount: 0, unreadCount: 0 })
      return
    }

    let query = req.supabase.from('notification_events')
      .select('id, actor_username, actor_display_name, type, conversation_id, invitation_id, created_at, read_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(50)
    let unreadQuery = req.supabase.from('notification_events')
      .select('id', { count: 'exact', head: true })
      .is('read_at', null)
    const visibleTypes = [
      ...(preferences.messages_enabled ? ['message'] : []),
      ...(preferences.invitations_enabled ? ['invitation', 'invitation_accepted'] : []),
    ]
    query = query.in('type', visibleTypes)
    unreadQuery = unreadQuery.in('type', visibleTypes)
    const { data, error, count } = await query
    if (error) throw error
    const { count: unreadCount, error: countError } = await unreadQuery
    if (countError) throw countError
    res.json({ notifications: data || [], totalCount: count || 0, unreadCount: unreadCount || 0 })
  } catch (error) {
    next(error)
  }
})

router.get('/unread-counts', async (req, res, next) => {
  try {
    const { data, error } = await req.supabase.rpc('list_private_conversation_unread_counts')
    if (error) throw error
    res.json({
      unreadCounts: (data || []).map((row) => ({
        conversationId: row.conversation_id,
        count: Number(row.unread_count),
      })),
    })
  } catch (error) {
    next(error)
  }
})

router.post('/:notificationId/read', async (req, res, next) => {
  const { notificationId } = req.params
  if (!isUuid(notificationId)) {
    res.status(400).json({ error: 'Notification ID must be a valid UUID.' })
    return
  }
  try {
    const { data, error } = await req.supabase.from('notification_events')
      .update({ read_at: new Date().toISOString() })
      .eq('id', notificationId)
      .is('read_at', null)
      .select('id')
    if (error) throw error
    req.app.get('io')?.to(`user:${req.user.id}`).emit('notification:changed', { type: 'read' })
    res.json({ updated: Boolean(data?.length) })
  } catch (error) {
    next(error)
  }
})

router.post('/read-all', async (req, res, next) => {
  try {
    const { data, error } = await req.supabase.from('notification_events')
      .update({ read_at: new Date().toISOString() })
      .is('read_at', null)
      .select('id')
    if (error) throw error
    req.app.get('io')?.to(`user:${req.user.id}`).emit('notification:changed', { type: 'read' })
    res.json({ updatedCount: data?.length || 0 })
  } catch (error) {
    next(error)
  }
})

router.post('/conversation/:conversationId/read', async (req, res, next) => {
  const { conversationId } = req.params
  if (!isUuid(conversationId)) {
    res.status(400).json({ error: 'Conversation ID must be a valid UUID.' })
    return
  }
  try {
    const { data, error } = await req.supabase.from('notification_events')
      .update({ read_at: new Date().toISOString() })
      .eq('conversation_id', conversationId)
      .eq('type', 'message')
      .is('read_at', null)
      .select('id')
    if (error) throw error
    req.app.get('io')?.to(`user:${req.user.id}`).emit('notification:changed', { type: 'read', conversationId })
    res.json({ updatedCount: data?.length || 0 })
  } catch (error) {
    next(error)
  }
})

router.get('/preferences', async (req, res, next) => {
  try {
    const { data, error } = await req.supabase.from('notification_preferences')
      .select('in_app_enabled, browser_enabled, sound_enabled, messages_enabled, invitations_enabled, preview_enabled, while_open_enabled')
      .eq('user_id', req.user.id)
      .maybeSingle()
    if (error) throw error
    res.json({ preferences: { ...DEFAULT_PREFERENCES, ...(data || {}) } })
  } catch (error) {
    next(error)
  }
})

router.patch('/preferences', async (req, res, next) => {
  const updates = req.body
  if (!updates || typeof updates !== 'object' || Array.isArray(updates) ||
    !Object.keys(updates).length ||
    Object.entries(updates).some(([key, value]) => !PREFERENCE_KEYS.has(key) || typeof value !== 'boolean')) {
    res.status(400).json({ error: 'Notification preference values are invalid.' })
    return
  }
  if (updates.browser_enabled && !isWebPushConfigured()) {
    res.status(503).json({ error: 'Browser push is not configured on the server yet.' })
    return
  }
  try {
    const { data, error } = await req.supabase.from('notification_preferences')
      .upsert({ user_id: req.user.id, ...updates, updated_at: new Date().toISOString() })
      .select('in_app_enabled, browser_enabled, sound_enabled, messages_enabled, invitations_enabled, preview_enabled, while_open_enabled')
      .single()
    if (error) throw error
    req.app.get('io')?.to(`user:${req.user.id}`).emit('notification:preferences-changed')
    res.json({ preferences: { ...DEFAULT_PREFERENCES, ...data } })
  } catch (error) {
    next(error)
  }
})

router.get('/push/public-key', (_req, res) => {
  res.json({ enabled: isWebPushConfigured(), publicKey: getPublicKey() })
})

router.post('/push/subscriptions', subscriptionRateLimit, async (req, res, next) => {
  const subscription = req.body?.subscription
  const endpoint = subscription?.endpoint
  const keys = subscription?.keys
  if (!isValidPushEndpoint(endpoint) ||
    !isValidPushKey(keys?.p256dh) ||
    !isValidPushKey(keys?.auth)) {
    res.status(400).json({ error: 'The browser push subscription is invalid or unsupported.' })
    return
  }
  try {
    const admin = createServiceRoleClient()
    const { data: existing, error: lookupError } = await admin.from('push_subscriptions')
      .select('id, user_id')
      .eq('endpoint', endpoint)
      .maybeSingle()
    if (lookupError) throw lookupError
    if (existing && existing.user_id !== req.user.id) {
      res.status(409).json({ error: 'This browser subscription is linked to another account. Sign out of that account first.' })
      return
    }

    const { error } = await admin.from('push_subscriptions')
      .upsert({
        ...(existing ? { id: existing.id } : {}),
        user_id: req.user.id,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'endpoint' })
    if (error) throw error
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

router.delete('/push/subscriptions', async (req, res, next) => {
  const endpoint = req.body?.endpoint
  if (!isValidPushEndpoint(endpoint)) {
    res.status(400).json({ error: 'The browser push subscription is invalid.' })
    return
  }
  try {
    const { error } = await req.supabase.from('push_subscriptions')
      .delete()
      .eq('user_id', req.user.id)
      .eq('endpoint', endpoint)
    if (error) throw error
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

module.exports = { DEFAULT_PREFERENCES, isValidPushEndpoint, isValidPushKey, router }
