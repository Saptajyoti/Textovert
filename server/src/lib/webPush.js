const webpush = require('web-push')
const { createServiceRoleClient } = require('./supabase')
const { isUuid } = require('../realtime/messaging')

function isWebPushConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT)
}

function getPublicKey() {
  return isWebPushConfigured() ? process.env.VAPID_PUBLIC_KEY : null
}

function configureWebPush() {
  if (!isWebPushConfigured()) return false
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  )
  return true
}

async function isConversationVisible(io, userId, conversationId) {
  if (!io || !conversationId) return false
  const sockets = await io.in(`user:${userId}`).fetchSockets()
  return sockets.some((socket) => (
    socket.data.pageVisible === true &&
    socket.data.visibleConversationId === conversationId
  ))
}

async function sendPush(notification, preview, io) {
  if (!notification || !configureWebPush()) return

  const admin = createServiceRoleClient()
  const [{ data: preferences, error: preferencesError }, { data: subscriptions, error: subscriptionsError }] =
    await Promise.all([
      admin.from('notification_preferences')
        .select('browser_enabled, messages_enabled, invitations_enabled, preview_enabled, while_open_enabled, sound_enabled')
        .eq('user_id', notification.recipient_id)
        .maybeSingle(),
      admin.from('push_subscriptions')
        .select('id, endpoint, p256dh, auth')
        .eq('user_id', notification.recipient_id),
    ])
  if (preferencesError || subscriptionsError) {
    console.error('[push] Could not load notification delivery settings.')
    return
  }
  if (!preferences?.browser_enabled ||
    (notification.type === 'message' && !preferences.messages_enabled) ||
    (notification.type !== 'message' && !preferences.invitations_enabled)) return
  if (!subscriptions?.length) return

  if (!preferences.while_open_enabled &&
    await isConversationVisible(io, notification.recipient_id, notification.conversation_id)) return
  const { data: claimed, error: claimError } = await admin.from('notification_events')
    .update({ push_sent_at: new Date().toISOString() })
    .eq('id', notification.id)
    .is('push_sent_at', null)
    .select('id')
  if (claimError) {
    console.error('[push] Could not claim notification delivery.')
    return
  }
  if (!claimed?.length) return

  const title = notification.type === 'invitation'
    ? 'New conversation invitation'
    : notification.type === 'invitation_accepted'
      ? 'Invitation accepted'
      : `Message from ${notification.actor_display_name || `@${notification.actor_username}`}`
  const body = notification.type === 'message' && preferences.preview_enabled && preview
    ? preview.slice(0, 120)
    : notification.type === 'invitation'
      ? `@${notification.actor_username} invited you to chat.`
      : notification.type === 'invitation_accepted'
        ? `@${notification.actor_username} accepted your invitation.`
        : 'You have a new message.'
  const url = notification.type === 'invitation'
    ? `/chat?invitation=${encodeURIComponent(notification.invitation_id)}`
    : `/chat?conversation=${encodeURIComponent(notification.conversation_id)}`
  const payload = JSON.stringify({
    title,
    body,
    url,
    tag: `${notification.type}:${notification.id}`,
    silent: !preferences.sound_enabled,
  })

  for (const subscription of subscriptions || []) {
    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      }, payload)
    } catch (error) {
      const status = error.statusCode
      if (status === 404 || status === 410) {
        const { error: deleteError } = await admin.from('push_subscriptions')
          .delete()
          .eq('id', subscription.id)
          .eq('user_id', notification.recipient_id)
        if (deleteError) console.error('[push] Could not remove an expired subscription.')
      } else {
        console.error(`[push] Delivery failed with status ${status || 'unknown'}.`)
      }
    }
  }
}

async function deliverPushForMessage(messageId, preview, io) {
  if (!isWebPushConfigured()) return
  const admin = createServiceRoleClient()
  const { data: notifications, error } = await admin.from('notification_events')
    .select('id, recipient_id, actor_username, actor_display_name, type, conversation_id, invitation_id')
    .eq('message_id', messageId)
    .eq('type', 'message')
    .is('read_at', null)
  if (error) {
    console.error('[push] Could not load message notification recipients.')
    return
  }
  for (const notification of notifications || []) {
    await sendPush(notification, preview, io)
  }
}

async function notifyMessageForConversation(messageId, io) {
  if (!io || !isUuid(messageId)) return
  const admin = createServiceRoleClient()
  const { data: notifications, error } = await admin.from('notification_events')
    .select('id, recipient_id, type, conversation_id')
    .eq('message_id', messageId)
    .eq('type', 'message')
  if (error) {
    console.error('[notifications] Could not load message notification recipients.')
    return
  }
  for (const notification of notifications || []) {
    io.to(`user:${notification.recipient_id}`).emit('notification:changed', {
      eventId: notification.id,
      type: notification.type,
      conversationId: notification.conversation_id,
    })
  }
}

async function notifyInvitationForConversation(conversationId, type, actorId, io) {
  if (!io || !isUuid(conversationId) || !isUuid(actorId)) return
  const admin = createServiceRoleClient()
  const { data: notifications, error } = await admin.from('notification_events')
    .select('id, recipient_id, actor_username, actor_display_name, type, conversation_id, invitation_id')
    .eq('conversation_id', conversationId)
    .eq('actor_id', actorId)
    .eq('type', type)
    .is('read_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) {
    console.error('[notifications] Could not load invitation notification recipient.')
    return
  }
  const notification = notifications?.[0]
  if (!notification) return
  io.to(`user:${notification.recipient_id}`).emit('notification:changed', {
    eventId: notification.id,
    type: notification.type,
    conversationId: notification.conversation_id,
  })
  await sendPush(notification, '', io)
}

async function notifyInvitation(invitationId, type, io) {
  if (!io || !isUuid(invitationId)) return
  const admin = createServiceRoleClient()
  const { data: notifications, error } = await admin.from('notification_events')
    .select('id, recipient_id, actor_username, actor_display_name, type, conversation_id, invitation_id')
    .eq('invitation_id', invitationId)
    .eq('type', type)
    .is('read_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) {
    console.error('[notifications] Could not load invitation notification recipient.')
    return
  }
  const notification = notifications?.[0]
  if (!notification) return
  io.to(`user:${notification.recipient_id}`).emit('notification:changed', {
    eventId: notification.id,
    type: notification.type,
    conversationId: notification.conversation_id,
  })
  await sendPush(notification, '', io)
}

module.exports = {
  deliverPushForMessage,
  getPublicKey,
  isWebPushConfigured,
  notifyMessageForConversation,
  notifyInvitation,
  notifyInvitationForConversation,
  sendPush,
}
