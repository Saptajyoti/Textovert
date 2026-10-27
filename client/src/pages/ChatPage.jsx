import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { ArrowLeft, Bell, Check, CheckCheck, CircleHelp, Copy, FileText, ImagePlus, LoaderCircle, LogOut, MessageCircle, MessageSquareReply, MoreHorizontal, Paperclip, Plus, Search, SearchX, Send, Settings2, Smile, SmilePlus, SquarePen, Users, X } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/useAuth.js'
import { getAccessToken, getSocketUrl, messagingRequest } from '../lib/messaging.js'
import { supabase } from '../lib/supabase.js'
import Brand from '../components/common/Brand.jsx'
import MessageAttachment from '../features/conversations/MessageAttachment.jsx'
import { formatFileSize, uploadAttachment, validateAttachment } from '../features/conversations/attachments.js'
import { GroupCreateDialog, GroupDetailsPanel } from '../features/conversations/GroupManagement.jsx'
import NotificationCenter from '../features/notifications/NotificationCenter.jsx'
import NotificationSettings from '../features/notifications/NotificationSettings.jsx'

const MESSAGE_PAGE_SIZE = 50

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value))
}

function mergeMessage(messages, message, clientId) {
  const withoutOptimistic = clientId
    ? messages.filter((item) => item.clientId !== clientId)
    : messages
  if (withoutOptimistic.some((item) => item.id === message.id)) return withoutOptimistic
  return [...withoutOptimistic, message].sort((left, right) => (
    new Date(left.created_at) - new Date(right.created_at) || left.id.localeCompare(right.id)
  ))
}

function highlightMatch(text, searchTerm) {
  const index = text.toLowerCase().indexOf(searchTerm.toLowerCase())
  if (index < 0 || !searchTerm) return text
  return <>
    {text.slice(0, index)}
    <mark>{text.slice(index, index + searchTerm.length)}</mark>
    {text.slice(index + searchTerm.length)}
  </>
}

export default function ChatPage() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [conversations, setConversations] = useState([])
  const [invitations, setInvitations] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [messages, setMessages] = useState([])
  const [cursor, setCursor] = useState(null)
  const [hasOlder, setHasOlder] = useState(false)
  const [loadingConversations, setLoadingConversations] = useState(true)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [sending, setSending] = useState(false)
  const [draft, setDraft] = useState('')
  const [connection, setConnection] = useState('connecting')
  const [partnerOnline, setPartnerOnline] = useState(null)
  const [typingUserId, setTypingUserId] = useState(null)
  const [pendingAttachment, setPendingAttachment] = useState(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [replyTarget, setReplyTarget] = useState(null)
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [messageSearch, setMessageSearch] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [searchHasMore, setSearchHasMore] = useState(false)
  const [highlightMessageId, setHighlightMessageId] = useState(null)
  const [error, setError] = useState('')
  const [logoutError, setLogoutError] = useState('')
  const [showMobileConversation, setShowMobileConversation] = useState(false)
  const [showNewChat, setShowNewChat] = useState(false)
  const [showGroupCreate, setShowGroupCreate] = useState(false)
  const [showGroupDetails, setShowGroupDetails] = useState(false)
  const [groupMemberState, setGroupMemberState] = useState({ conversationId: null, members: [] })
  const [usernameSearch, setUsernameSearch] = useState('')
  const [lookupResult, setLookupResult] = useState(null)
  const [lookupLoading, setLookupLoading] = useState(false)
  const [invitationSending, setInvitationSending] = useState(false)
  const [respondingInvitationId, setRespondingInvitationId] = useState('')
  const [invitationNotice, setInvitationNotice] = useState('')
  const [invitationError, setInvitationError] = useState('')
  const [notifications, setNotifications] = useState([])
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0)
  const [unreadCounts, setUnreadCounts] = useState({})
  const [loadingNotifications, setLoadingNotifications] = useState(false)
  const [notificationsError, setNotificationsError] = useState('')
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [notificationSettingsOpen, setNotificationSettingsOpen] = useState(false)
  const [notificationPreferences, setNotificationPreferences] = useState({
    in_app_enabled: true,
    browser_enabled: false,
    sound_enabled: false,
    messages_enabled: true,
    invitations_enabled: true,
    preview_enabled: false,
    while_open_enabled: false,
  })
  const [notificationSettingsLoading, setNotificationSettingsLoading] = useState(false)
  const [notificationSettingsError, setNotificationSettingsError] = useState('')
  const [browserPermission, setBrowserPermission] = useState(
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported',
  )
  const [pushConfigured, setPushConfigured] = useState(false)
  const socketRef = useRef(null)
  const activeIdRef = useRef(null)
  const typingStopTimerRef = useRef(null)
  const typingStartSentAtRef = useRef(0)
  const readRequestedRef = useRef(new Set())
  const attachmentPreviewUrlRef = useRef(null)
  const threadRef = useRef(null)
  const shouldScrollToBottom = useRef(true)
  const olderScrollPosition = useRef(null)
  const fileInputRef = useRef(null)
  const uploadControllerRef = useRef(null)
  const messageRefs = useRef(new Map())
  const notificationPreferencesRef = useRef(notificationPreferences)
  const recentSoundEventRef = useRef(new Set())
  const showMobileConversationRef = useRef(showMobileConversation)
  const cancelUploadRef = useRef(null)

  const activeConversation = conversations.find((conversation) => conversation.id === activeId)
  const groupMembers = useMemo(() => (
    groupMemberState.conversationId === activeId ? groupMemberState.members : []
  ), [activeId, groupMemberState])
  const groupMembersById = useMemo(
    () => new Map(groupMembers.map((member) => [member.user_id, member])),
    [groupMembers],
  )
  const firstUnreadMessageId = messages.find((message) => (
    !message.pending && message.sender_id !== user?.id && !message.read
  ))?.id
  const filteredConversations = useMemo(() => conversations.filter((conversation) => (
    (conversation.title || 'Private conversation').toLowerCase().includes(query.toLowerCase())
  )), [conversations, query])
  const setGroupMembers = useCallback((members) => {
    setGroupMemberState({ conversationId: activeIdRef.current, members })
  }, [])
  const updateGroupMembers = setGroupMembers

  useEffect(() => {
    let cancelled = false
    if (activeConversation?.kind !== 'group') {
      return undefined
    }
    messagingRequest(`/groups/${activeConversation.id}/members`)
      .then((result) => {
        if (!cancelled) setGroupMemberState({
          conversationId: activeConversation.id,
          members: result.members || [],
        })
      })
      .catch((membersError) => {
        if (!cancelled) setError(membersError.message)
      })
    return () => { cancelled = true }
  }, [activeConversation?.id, activeConversation?.kind])

  function groupMemberName(memberId) {
    const member = groupMembersById.get(memberId)
    return member?.display_name || member?.username || 'Group member'
  }

  async function openCreatedGroup(conversationId) {
    const updatedConversations = await loadConversations()
    if (updatedConversations?.some((conversation) => conversation.id === conversationId)) {
      openConversation(conversationId)
    }
  }

  const stopTyping = useCallback((conversationId = activeIdRef.current) => {
    if (typingStopTimerRef.current) {
      window.clearTimeout(typingStopTimerRef.current)
      typingStopTimerRef.current = null
    }
    if (conversationId && socketRef.current?.connected) {
      socketRef.current.emit('typing:stop', { conversationId })
    }
    typingStartSentAtRef.current = 0
  }, [])

  const setAttachmentPreviewElement = useCallback((element) => {
    if (attachmentPreviewUrlRef.current) {
      URL.revokeObjectURL(attachmentPreviewUrlRef.current)
      attachmentPreviewUrlRef.current = null
    }
    if (element && pendingAttachment?.metadata.type === 'image') {
      const url = URL.createObjectURL(pendingAttachment.file)
      attachmentPreviewUrlRef.current = url
      element.src = url
    }
  }, [pendingAttachment])

  function handleDraftChange(value) {
    setDraft(value)
    if (!value.trim()) {
      stopTyping()
      return
    }

    const socket = socketRef.current
    const conversationId = activeIdRef.current
    if (!socket?.connected || !conversationId) return
    const now = Date.now()
    if (now - typingStartSentAtRef.current >= 1500) {
      socket.emit('typing:start', { conversationId })
      typingStartSentAtRef.current = now
    }
    if (typingStopTimerRef.current) window.clearTimeout(typingStopTimerRef.current)
    typingStopTimerRef.current = window.setTimeout(() => stopTyping(conversationId), 2500)
  }

  const loadConversations = useCallback(async () => {
    setLoadingConversations(true)
    try {
      const result = await messagingRequest('/conversations')
      setConversations(result.conversations || [])
      setError('')
      return result.conversations || []
    } catch (loadError) {
      setError(loadError.message)
      return null
    } finally {
      setLoadingConversations(false)
    }
  }, [])

  const loadInvitations = useCallback(async () => {
    try {
      const result = await messagingRequest('/conversations/invitations')
      setInvitations(result.invitations || [])
    } catch (loadError) {
      setInvitationError(loadError.message)
    }
  }, [])

  const loadNotifications = useCallback(async () => {
    setLoadingNotifications(true)
    setNotificationsError('')
    try {
      const result = await messagingRequest('/notifications')
      setNotifications(result.notifications || [])
      setUnreadNotificationCount(result.unreadCount || 0)
    } catch (loadError) {
      setNotificationsError(loadError.message)
    } finally {
      setLoadingNotifications(false)
    }
  }, [])

  const loadUnreadCounts = useCallback(async () => {
    try {
      const result = await messagingRequest('/notifications/unread-counts')
      setUnreadCounts(Object.fromEntries((result.unreadCounts || []).map((item) => [
        item.conversationId,
        item.count,
      ])))
    } catch (loadError) {
      setError(loadError.message)
    }
  }, [])

  const loadNotificationPreferences = useCallback(async () => {
    try {
      const [preferenceResult, pushResult] = await Promise.all([
        messagingRequest('/notifications/preferences'),
        messagingRequest('/notifications/push/public-key'),
      ])
      setNotificationPreferences(preferenceResult.preferences)
      setPushConfigured(Boolean(pushResult.enabled && pushResult.publicKey))
    } catch (loadError) {
      setNotificationSettingsError(loadError.message)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadConversations()
      loadInvitations()
      loadNotifications()
      loadUnreadCounts()
      loadNotificationPreferences()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadConversations, loadInvitations, loadNotifications, loadNotificationPreferences, loadUnreadCounts, user?.id])

  async function updateNotificationPreference(key, value) {
    setNotificationSettingsLoading(true)
    setNotificationSettingsError('')
    try {
      const result = await messagingRequest('/notifications/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ [key]: value }),
      })
      setNotificationPreferences(result.preferences)
    } catch (saveError) {
      setNotificationSettingsError(saveError.message)
    } finally {
      setNotificationSettingsLoading(false)
    }
  }

  async function getBrowserPushSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null
    const registration = await navigator.serviceWorker.getRegistration('/')
    return registration?.pushManager.getSubscription() || null
  }

  async function removeBrowserPushSubscription() {
    const subscription = await getBrowserPushSubscription()
    if (!subscription) return
    await messagingRequest('/notifications/push/subscriptions', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    })
    await subscription.unsubscribe()
  }

  async function enableBrowserNotifications() {
    setNotificationSettingsLoading(true)
    setNotificationSettingsError('')
    let subscription = null
    try {
      if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
        throw new Error('This browser does not support Web Push notifications.')
      }
      let permission = Notification.permission
      if (permission === 'default') permission = await Notification.requestPermission()
      setBrowserPermission(permission)
      if (permission !== 'granted') {
        if (permission === 'denied') throw new Error('Browser notifications are blocked. Change permission in your browser settings to enable them.')
        throw new Error('Browser notification permission was not granted.')
      }

      const { publicKey, enabled } = await messagingRequest('/notifications/push/public-key')
      if (!enabled || !publicKey) throw new Error('Web Push is not configured on the server.')
      const registration = await navigator.serviceWorker.register('/service-worker.js')
      subscription = await registration.pushManager.getSubscription()
      if (!subscription) {
        const paddedPublicKey = publicKey.replace(/-/g, '+').replace(/_/g, '/')
          .padEnd(publicKey.length + (4 - publicKey.length % 4) % 4, '=')
        const applicationServerKey = Uint8Array.from(
          atob(paddedPublicKey),
          (character) => character.charCodeAt(0),
        )
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        })
      }
      await messagingRequest('/notifications/push/subscriptions', {
        method: 'POST',
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      })
      const result = await messagingRequest('/notifications/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ browser_enabled: true }),
      })
      setNotificationPreferences(result.preferences)
      setPushConfigured(true)
    } catch (enableError) {
      if (subscription) {
        try {
          await messagingRequest('/notifications/push/subscriptions', {
            method: 'DELETE',
            body: JSON.stringify({ endpoint: subscription.endpoint }),
          })
          await subscription.unsubscribe()
        } catch {
          setNotificationSettingsError(`${enableError.message} The subscription cleanup also failed; disable browser notifications after setup is restored.`)
          setNotificationSettingsLoading(false)
          return
        }
      }
      setNotificationSettingsError(enableError.message)
    } finally {
      setNotificationSettingsLoading(false)
    }
  }

  async function disableBrowserNotifications() {
    setNotificationSettingsLoading(true)
    setNotificationSettingsError('')
    try {
      await messagingRequest('/notifications/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ browser_enabled: false }),
      }).then((result) => setNotificationPreferences(result.preferences))
      await removeBrowserPushSubscription()
    } catch (disableError) {
      setNotificationSettingsError(disableError.message)
    } finally {
      setNotificationSettingsLoading(false)
    }
  }

  useEffect(() => {
    if (!user?.id) return undefined

    const socket = io(getSocketUrl(), {
      autoConnect: false,
      auth: (callback) => {
        getAccessToken()
          .then((accessToken) => callback({ accessToken }))
          .catch((authError) => {
            callback({ accessToken: '' })
            setError(authError.message)
          })
      },
    })
    socketRef.current = socket

    socket.on('connect', () => {
      setConnection('connected')
      setError('')
      setPartnerOnline(null)
      setTypingUserId(null)
      loadNotifications()
      loadUnreadCounts()
      loadInvitations()
      const conversationId = activeIdRef.current
      if (conversationId) {
        socket.emit('conversation:join', { conversationId }, (result) => {
          if (!result?.ok) setError(result?.error || 'Could not join this conversation.')
          else if (activeIdRef.current === conversationId && result.partnerOnline !== null) {
            setPartnerOnline(Boolean(result.partnerOnline))
          }
        })
      }
    })
    socket.on('disconnect', (reason) => {
      setConnection(reason === 'io client disconnect' ? 'disconnected' : 'reconnecting')
      setPartnerOnline(null)
      setTypingUserId(null)
      if (typingStopTimerRef.current) window.clearTimeout(typingStopTimerRef.current)
      typingStopTimerRef.current = null
      typingStartSentAtRef.current = 0
    })
    socket.on('connect_error', (connectError) => {
      setConnection('disconnected')
      setError(connectError.message || 'Real-time connection failed. Retrying…')
    })
    socket.io.on('reconnect_attempt', () => setConnection('reconnecting'))
    socket.on('message:new', ({ message, clientId }) => {
      if (message?.conversation_id !== activeIdRef.current) return
      setMessages((current) => mergeMessage(current, { ...message, reactions: [] }, clientId))
    })
    socket.on('presence:update', ({ conversationId, userId: changedUserId, online }) => {
      if (conversationId === activeIdRef.current && changedUserId !== user?.id) {
        setPartnerOnline(Boolean(online))
      }
    })
    socket.on('presence:error', ({ error: presenceError }) => {
      setError(presenceError || 'Presence is temporarily unavailable.')
    })
    socket.on('typing:update', ({ conversationId, userId: typingId, typing }) => {
      if (conversationId !== activeIdRef.current || typingId === user?.id) return
      setTypingUserId(typing ? typingId : (current) => current === typingId ? null : current)
    })
    socket.on('conversation:removed', ({ conversationId }) => {
      loadConversations()
      if (activeIdRef.current !== conversationId) return
      activeIdRef.current = null
      setActiveId(null)
      setMessages([])
      setShowGroupDetails(false)
      setShowMobileConversation(false)
      setError('You are no longer a member of this group.')
    })
    socket.on('message:read', ({ conversationId, messageIds }) => {
      if (conversationId !== activeIdRef.current || !Array.isArray(messageIds)) return
      const readIds = new Set(messageIds)
      messageIds.forEach((id) => readRequestedRef.current.delete(id))
      setMessages((current) => current.map((message) => (
        message.sender_id === user?.id && readIds.has(message.id)
          ? { ...message, read: true }
          : message
      )))
    })
    socket.on('message:reaction', ({ conversationId, messageId, userId: reactingUserId, reaction, action }) => {
      if (conversationId !== activeIdRef.current) return
      setMessages((current) => current.map((message) => {
        if (message.id !== messageId) return message
        const reactions = [...(message.reactions || [])]
        const index = reactions.findIndex((entry) => entry.reaction === reaction)
        const currentReaction = index >= 0 ? reactions[index] : null
        if (action === 'add') {
          if (currentReaction) {
            reactions[index] = {
              ...currentReaction,
              count: currentReaction.count + 1,
              mine: currentReaction.mine || reactingUserId === user?.id,
            }
          } else {
            reactions.push({ reaction, count: 1, mine: reactingUserId === user?.id })
          }
        } else if (currentReaction) {
          if (currentReaction.count <= 1) reactions.splice(index, 1)
          else reactions[index] = {
            ...currentReaction,
            count: currentReaction.count - 1,
            mine: reactingUserId === user?.id ? false : currentReaction.mine,
          }
        }
        return { ...message, reactions }
      }))
    })
    socket.on('notification:changed', (event) => {
      loadNotifications()
      loadUnreadCounts()
      if (event?.type === 'invitation') loadInvitations()
      if (event?.type === 'invitation_accepted') loadConversations()
      if (event?.type === 'group') {
        loadConversations()
        if (activeIdRef.current === event.conversationId) {
          messagingRequest(`/groups/${event.conversationId}/members`)
            .then((result) => setGroupMembers(result.members || []))
            .catch((membersError) => setError(membersError.message))
        }
      }
      if (event?.type === 'preferences-changed') loadNotificationPreferences()

      const currentPreferences = notificationPreferencesRef.current
      const isVisible = document.visibilityState === 'visible'
      const mobileView = window.matchMedia('(max-width: 720px)').matches
      const activeConversationVisible = isVisible &&
        activeIdRef.current === event?.conversationId &&
        (!mobileView || showMobileConversationRef.current)
      if (event?.type !== 'message' || !currentPreferences.sound_enabled ||
        !currentPreferences.messages_enabled || !isVisible ||
        (activeConversationVisible && !currentPreferences.while_open_enabled)) return

      const soundEventId = event.eventId || `${event.type}:${event.conversationId}`
      try {
        const key = 'textovert:played-notification-sounds'
        const previous = JSON.parse(localStorage.getItem(key) || '[]')
        if (Array.isArray(previous) && previous.includes(soundEventId)) return
        localStorage.setItem(key, JSON.stringify([
          ...(Array.isArray(previous) ? previous : []),
          soundEventId,
        ].slice(-100)))
      } catch {
        if (recentSoundEventRef.current.has(soundEventId)) return
      }
      recentSoundEventRef.current.add(soundEventId)
      if (recentSoundEventRef.current.size > 100) {
        recentSoundEventRef.current.delete(recentSoundEventRef.current.values().next().value)
      }
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext
        if (!AudioContextClass) return
        const audio = new AudioContextClass()
        const oscillator = audio.createOscillator()
        const gain = audio.createGain()
        oscillator.type = 'sine'
        oscillator.frequency.value = 660
        gain.gain.setValueAtTime(0.035, audio.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.12)
        oscillator.connect(gain)
        gain.connect(audio.destination)
        oscillator.start()
        oscillator.stop(audio.currentTime + 0.12)
        oscillator.onended = () => audio.close().catch(() => {})
        audio.resume().catch(() => {})
      } catch {
        // Audio is an optional enhancement and may be blocked by browser policy.
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'TOKEN_REFRESHED' && session?.access_token) {
        socket.auth = { accessToken: session.access_token }
        socket.disconnect()
        socket.connect()
      }
    })

    socket.connect()
    return () => {
      subscription.unsubscribe()
      socket.removeAllListeners()
      socket.io.removeAllListeners()
      socket.disconnect()
      socketRef.current = null
    }
  }, [loadConversations, loadInvitations, loadNotifications, loadNotificationPreferences, loadUnreadCounts, setGroupMembers, user?.id])

  useEffect(() => {
    const reportVisibility = () => {
      const mobileView = window.matchMedia('(max-width: 720px)').matches
      const visible = document.visibilityState === 'visible' &&
        Boolean(activeIdRef.current) &&
        (!mobileView || showMobileConversation)
      socketRef.current?.emit('notification:visibility', {
        visible,
        conversationId: visible ? activeIdRef.current : null,
      })
    }
    reportVisibility()
    const mobileQuery = window.matchMedia('(max-width: 720px)')
    document.addEventListener('visibilitychange', reportVisibility)
    mobileQuery.addEventListener('change', reportVisibility)
    return () => {
      document.removeEventListener('visibilitychange', reportVisibility)
      mobileQuery.removeEventListener('change', reportVisibility)
    }
  }, [activeId, connection, showMobileConversation])

  useEffect(() => {
    const socket = socketRef.current
    if (!socket) return undefined
    setPartnerOnline(null)
    setTypingUserId(null)
    if (activeId && socket.connected) {
      socket.emit('conversation:join', { conversationId: activeId }, (result) => {
        if (!result?.ok) setError(result?.error || 'Could not join this conversation.')
        else if (activeIdRef.current === activeId && result.partnerOnline !== null) {
          setPartnerOnline(Boolean(result.partnerOnline))
        }
      })
    }
    return () => {
      if (activeId) {
        stopTyping(activeId)
        if (socket.connected) socket.emit('conversation:leave', { conversationId: activeId })
      }
    }
  }, [activeId, stopTyping])

  useLayoutEffect(() => {
    const thread = threadRef.current
    if (!thread) return
    if (olderScrollPosition.current) {
      thread.scrollTop = olderScrollPosition.current.top + thread.scrollHeight - olderScrollPosition.current.height
      olderScrollPosition.current = null
    } else if (shouldScrollToBottom.current) {
      thread.scrollTop = thread.scrollHeight
    }
  }, [messages])

  useEffect(() => {
    if (!activeId) return undefined

    let cancelled = false
    messagingRequest(`/conversations/${activeId}/messages?limit=${MESSAGE_PAGE_SIZE}`)
      .then((result) => {
        if (cancelled) return
        setMessages((current) => (result.messages || []).reduce(
          (merged, message) => mergeMessage(merged, message),
          current,
        ))
        setHasOlder(Boolean(result.hasMore))
        setCursor(result.nextCursor || null)
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError.message)
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false)
      })
    return () => { cancelled = true }
  }, [activeId])

  useEffect(() => {
    if (!activeId || !user?.id) return undefined

    const markIncomingMessagesRead = () => {
      const mobileView = window.matchMedia('(max-width: 720px)').matches
      if (document.visibilityState !== 'visible' || (mobileView && !showMobileConversation)) return
      const socket = socketRef.current
      if (!socket?.connected) return
      const unreadIds = messages
        .filter((message) => (
          message.sender_id !== user.id &&
          !message.pending &&
          !message.read &&
          !readRequestedRef.current.has(message.id)
        ))
        .map((message) => message.id)
      if (!unreadIds.length) return

      unreadIds.forEach((id) => readRequestedRef.current.add(id))
      socket.timeout(10000).emit('conversation:read', { conversationId: activeId }, (timeoutError, result) => {
        if (timeoutError || !result?.ok) {
          unreadIds.forEach((id) => readRequestedRef.current.delete(id))
          setError(result?.error || 'Read receipts could not be updated. They will retry when you reconnect.')
        } else {
          setMessages((current) => current.map((message) => (
            message.sender_id !== user.id && !message.pending
              ? { ...message, read: true }
              : message
          )))
          loadUnreadCounts()
        }
      })
    }

    markIncomingMessagesRead()
    document.addEventListener('visibilitychange', markIncomingMessagesRead)
    return () => document.removeEventListener('visibilitychange', markIncomingMessagesRead)
  }, [activeId, loadUnreadCounts, messages, showMobileConversation, user?.id, connection])

  useEffect(() => {
    const term = messageSearch.trim()
    if (!searchOpen || !activeId || !term) return undefined

    let cancelled = false
    const timer = window.setTimeout(() => {
      setSearchLoading(true)
      setSearchError('')
      messagingRequest(`/conversations/search/${activeId}?q=${encodeURIComponent(term)}`)
        .then((result) => {
          if (cancelled) return
          setSearchResults(result.messages || [])
          setSearchHasMore(Boolean(result.hasMore))
        })
        .catch((searchFailure) => {
          if (!cancelled) setSearchError(searchFailure.message)
        })
        .finally(() => {
          if (!cancelled) setSearchLoading(false)
        })
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activeId, messageSearch, searchOpen])

  useEffect(() => () => {
    uploadControllerRef.current?.abort()
  }, [])

  function chooseAttachment(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    validateAttachment(file)
      .then((metadata) => {
        setPendingAttachment({ file, metadata, uploaded: null })
        setUploadProgress(0)
        setError('')
      })
      .catch((validationError) => setError(validationError.message))
  }

  const cancelUpload = useCallback(async () => {
    uploadControllerRef.current?.abort()
    uploadControllerRef.current = null
    if (pendingAttachment?.uploaded && supabase) {
      try {
        const { error: removeError } = await supabase.storage
          .from('conversation-media')
          .remove([pendingAttachment.uploaded.path])
        if (removeError) setError('Upload cancelled, but its stored file could not be removed.')
      } catch {
        setError('Upload cancelled, but its stored file could not be removed.')
      }
    }
    setPendingAttachment(null)
    setUploadProgress(0)
    setSending(false)
  }, [pendingAttachment])

  function toggleReaction(message, reaction) {
    const socket = socketRef.current
    if (!socket?.connected || message.pending) return
    const selected = (message.reactions || []).some((entry) => entry.reaction === reaction && entry.mine)
    socket.timeout(8000).emit(
      selected ? 'reaction:remove' : 'reaction:add',
      { conversationId: activeId, messageId: message.id, reaction },
      (timeoutError, result) => {
        if (timeoutError || !result?.ok) {
          setError(result?.error || 'Reaction could not be updated.')
        }
      },
    )
  }

  async function copyMessage(text) {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard access is unavailable.')
      await navigator.clipboard.writeText(text)
    } catch {
      setError('Message could not be copied.')
    }
  }

  async function navigateToMessage(messageId) {
    let message = messages.find((item) => item.id === messageId)
    if (!message) {
      try {
        const result = await messagingRequest(`/conversations/${activeId}/messages/${messageId}`)
        message = result.message
        setMessages((current) => mergeMessage(current, message))
      } catch (loadError) {
        setError(loadError.message)
        return
      }
    }
    setSearchOpen(false)
    setReplyTarget(null)
    setHighlightMessageId(messageId)
    window.setTimeout(() => {
      messageRefs.current.get(messageId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      window.setTimeout(() => setHighlightMessageId(null), 1600)
    }, 0)
  }

  async function loadOlderMessages() {
    if (!activeId || !cursor || loadingOlder) return
    if (threadRef.current) {
      olderScrollPosition.current = {
        top: threadRef.current.scrollTop,
        height: threadRef.current.scrollHeight,
      }
    }
    setLoadingOlder(true)
    try {
      const parameters = new URLSearchParams({
        limit: String(MESSAGE_PAGE_SIZE),
        beforeCreatedAt: cursor.beforeCreatedAt,
        beforeId: cursor.beforeId,
      })
      const result = await messagingRequest(`/conversations/${activeId}/messages?${parameters}`)
      setMessages((current) => {
        const knownIds = new Set(current.map((message) => message.id))
        return [...(result.messages || []).filter((message) => !knownIds.has(message.id)), ...current]
      })
      setHasOlder(Boolean(result.hasMore))
      setCursor(result.nextCursor || null)
    } catch (loadError) {
      setError(loadError.message)
    } finally {
      setLoadingOlder(false)
    }
  }

  const openConversation = useCallback((conversationId) => {
    if (sending) {
      setError('Cancel the current upload or wait for the message to send before switching conversations.')
      return
    }
    if (pendingAttachment) cancelUploadRef.current?.()
    stopTyping(activeIdRef.current)
    activeIdRef.current = conversationId
    readRequestedRef.current = new Set()
    setPartnerOnline(null)
    setTypingUserId(null)
    shouldScrollToBottom.current = true
    olderScrollPosition.current = null
    setActiveId(conversationId)
    setDraft('')
    setReplyTarget(null)
    setSearchOpen(false)
    setMessageSearch('')
    setReactionPickerMessageId(null)
    setMessages([])
    setCursor(null)
    setHasOlder(false)
    setLoadingMessages(true)
    setError('')
    setShowMobileConversation(true)
  }, [pendingAttachment, sending, stopTyping])
  async function markNotificationRead(notificationId) {
    try {
      await messagingRequest(`/notifications/${notificationId}/read`, { method: 'POST' })
      await loadNotifications()
    } catch (readError) {
      setNotificationsError(readError.message)
    }
  }

  async function markAllNotificationsRead() {
    try {
      await messagingRequest('/notifications/read-all', { method: 'POST' })
      await loadNotifications()
    } catch (readError) {
      setNotificationsError(readError.message)
    }
  }

  async function activateNotification(notification) {
    if (!notification.read_at) await markNotificationRead(notification.id)
    setNotificationsOpen(false)
    if (notification.type === 'invitation') {
      setTimeout(() => document.getElementById(`invitation-${notification.invitation_id}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      }), 0)
      return
    }
    const conversationList = await loadConversations()
    if (conversationList?.some((conversation) => conversation.id === notification.conversation_id)) {
      openConversation(notification.conversation_id)
    } else {
      setError('That conversation is no longer available.')
    }
  }

  async function handleLookup(event) {
    event.preventDefault()
    const username = usernameSearch.trim()
    setLookupResult(null)
    setInvitationError('')
    setInvitationNotice('')
    if (!/^[a-z0-9_]{3,32}$/i.test(username)) {
      setInvitationError('Enter a username with 3 to 32 letters, numbers, or underscores.')
      return
    }

    setLookupLoading(true)
    try {
      const result = await messagingRequest(`/conversations/users/lookup?username=${encodeURIComponent(username)}`)
      setLookupResult(result)
    } catch (lookupError) {
      setInvitationError(lookupError.message)
    } finally {
      setLookupLoading(false)
    }
  }

  async function handleInvite() {
    if (!lookupResult?.username || invitationSending) return
    setInvitationSending(true)
    setInvitationError('')
    setInvitationNotice('')
    try {
      const result = await messagingRequest('/conversations/invitations', {
        method: 'POST',
        body: JSON.stringify({ username: lookupResult.username }),
      })
      if (result.status === 'existing') {
        await loadConversations()
        setShowNewChat(false)
        openConversation(result.conversation_id)
        return
      }
      setLookupResult((current) => ({ ...current, relationship: result.status }))
      setInvitationNotice(`Invitation sent to @${result.username || lookupResult.username}.`)
      await loadInvitations()
    } catch (inviteError) {
      if (inviteError.message.includes('already invited you')) {
        setLookupResult((current) => ({ ...current, relationship: 'invitation_received' }))
      }
      setInvitationError(inviteError.message)
      await loadInvitations()
    } finally {
      setInvitationSending(false)
    }
  }

  async function handleInvitationResponse(invitationId, action) {
    if (respondingInvitationId) return
    setRespondingInvitationId(invitationId)
    setInvitationError('')
    setInvitationNotice('')
    try {
      const result = await messagingRequest(`/conversations/invitations/${invitationId}/${action}`, {
        method: 'POST',
      })
      await loadInvitations()
      if (action === 'accept' && result.status === 'accepted') {
        const conversationList = await loadConversations()
        setInvitationNotice('Invitation accepted. Your private conversation is ready.')
        if (conversationList?.some((conversation) => conversation.id === result.conversation_id)) {
          setShowNewChat(false)
          openConversation(result.conversation_id)
        }
      } else {
        setInvitationNotice('Invitation rejected.')
      }
    } catch (responseError) {
      setInvitationError(responseError.message)
    } finally {
      setRespondingInvitationId('')
    }
  }

  async function handleSend(event) {
    event.preventDefault()
    const body = draft.trim()
    if ((!body && !pendingAttachment) || sending) return
    if ([...body].length > 10000) {
      setError('Messages cannot exceed 10,000 characters.')
      return
    }
    const socket = socketRef.current
    if (!socket?.connected) {
      setError('You are offline. Reconnect before sending your message.')
      return
    }

    setSending(true)
    setError('')
    let uploadedAttachment = pendingAttachment?.uploaded || null
    if (pendingAttachment && !uploadedAttachment) {
      const controller = new AbortController()
      uploadControllerRef.current = controller
      try {
        uploadedAttachment = await uploadAttachment(
          pendingAttachment.file,
          activeId,
          setUploadProgress,
          controller.signal,
        )
        setPendingAttachment((current) => current
          ? { ...current, uploaded: uploadedAttachment }
          : current)
      } catch (uploadError) {
        if (!controller.signal.aborted) setError(uploadError.message)
        setSending(false)
        uploadControllerRef.current = null
        return
      }
      uploadControllerRef.current = null
    }

    const clientId = crypto.randomUUID()
    stopTyping(activeId)
    const messageBody = body || uploadedAttachment?.name
    const optimisticMessage = {
      id: `pending-${clientId}`,
      clientId,
      conversation_id: activeId,
      sender_id: user.id,
      body: messageBody,
      created_at: new Date().toISOString(),
      pending: true,
      message_type: uploadedAttachment?.type || 'text',
      attachment_name: uploadedAttachment?.name,
      attachment_mime: uploadedAttachment?.mimeType,
      attachment_size: uploadedAttachment?.size,
      reply_to_id: replyTarget?.id || null,
      reply: replyTarget || null,
      reactions: [],
    }
    setMessages((current) => [...current, optimisticMessage])
    setDraft('')
    socket.timeout(15000).emit(
      'message:send',
      {
        conversationId: activeId,
        body,
        clientId,
        ...(uploadedAttachment ? { attachment: uploadedAttachment } : {}),
        ...(replyTarget ? { replyToId: replyTarget.id } : {}),
      },
      (timeoutError, result) => {
        setSending(false)
        if (timeoutError || !result?.ok) {
          setMessages((current) => current.filter((message) => message.clientId !== clientId))
          setError(result?.error || 'Message sending timed out. Check your connection and try again.')
          setDraft(body)
          if (timeoutError && uploadedAttachment) {
            setPendingAttachment((current) => current
              ? { ...current, uploaded: uploadedAttachment }
              : current)
          } else if (uploadedAttachment && supabase) {
            supabase.storage.from('conversation-media').remove([uploadedAttachment.path])
              .then(({ error: removeError }) => {
                if (removeError) setError('Message could not be sent and its uploaded file could not be removed.')
                setPendingAttachment((current) => current
                  ? { ...current, uploaded: null }
                  : current)
              })
          }
          return
        }
        setMessages((current) => mergeMessage(current, result.message, clientId))
        setPendingAttachment(null)
        setUploadProgress(0)
        setReplyTarget(null)
      },
    )
  }

  async function handleSignOut() {
    setLogoutError('')
    try {
      if (notificationPreferences.browser_enabled) {
        await messagingRequest('/notifications/preferences', {
          method: 'PATCH',
          body: JSON.stringify({ browser_enabled: false }),
        })
        await removeBrowserPushSubscription()
      }
      await signOut()
      navigate('/login', { replace: true })
    } catch (signOutError) {
      setLogoutError(signOutError.message || 'Unable to sign out. Please try again.')
    }
  }

  const connectionText = {
    connecting: 'Connecting…',
    connected: 'Live',
    reconnecting: 'Reconnecting…',
    disconnected: 'Offline',
  }[connection]
  const partnerDisplayName = activeConversation?.partner_display_name ||
    activeConversation?.partner_username ||
    activeConversation?.title ||
    'Your contact'

  const requestedConversationId = searchParams.get('conversation')
  const requestedInvitationId = searchParams.get('invitation')
  const browserSupported = typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window

  useEffect(() => {
    notificationPreferencesRef.current = notificationPreferences
    showMobileConversationRef.current = showMobileConversation
  }, [notificationPreferences, showMobileConversation])

  useEffect(() => {
    cancelUploadRef.current = cancelUpload
  }, [cancelUpload])

  useEffect(() => {
    if (!requestedConversationId || loadingConversations) return
    const timer = window.setTimeout(() => {
      if (conversations.some((conversation) => conversation.id === requestedConversationId)) {
        openConversation(requestedConversationId)
      } else {
        setError('That conversation is no longer available.')
      }
      setSearchParams({}, { replace: true })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [conversations, loadingConversations, openConversation, requestedConversationId, setSearchParams])

  useEffect(() => {
    if (!requestedInvitationId) return
    setSearchParams({}, { replace: true })
    const timer = window.setTimeout(() => {
      loadInvitations().then(() => {
        window.setTimeout(() => {
          document.getElementById(`invitation-${requestedInvitationId}`)?.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
          })
        }, 100)
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadInvitations, requestedInvitationId, setSearchParams])

  useEffect(() => {
    const updatePermission = () => {
      setBrowserPermission('Notification' in window ? Notification.permission : 'unsupported')
    }
    window.addEventListener('focus', updatePermission)
    return () => window.removeEventListener('focus', updatePermission)
  }, [])

  return (
    <main className={`messenger${showMobileConversation ? ' mobile-conversation-open' : ''}`}>
      <aside className="app-rail">
        <Brand compact />
        <button className="rail-action rail-action-active" aria-label="Messages"><MessageCircle size={19} /></button>
        <button className="rail-action" aria-label="Create a group" title="Create a group" onClick={() => setShowGroupCreate(true)}><Users size={19} /></button>
        <div className="rail-spacer" />
        <button
          className={`rail-action${notificationsOpen ? ' rail-action-active' : ''}`}
          aria-label={`Notifications${unreadNotificationCount ? `, ${unreadNotificationCount} unread` : ''}`}
          aria-expanded={notificationsOpen}
          title="Notifications"
          onClick={() => {
            setNotificationsOpen((open) => !open)
            setNotificationSettingsOpen(false)
            if (!notificationsOpen) loadNotifications()
          }}
        ><Bell size={18} />{notificationPreferences.in_app_enabled && unreadNotificationCount > 0 && <span className="rail-notification-badge">{unreadNotificationCount > 99 ? '99+' : unreadNotificationCount}</span>}</button>
        <button
          className={`rail-action${notificationSettingsOpen ? ' rail-action-active' : ''}`}
          aria-label="Notification settings"
          title="Notification settings"
          onClick={() => {
            setNotificationSettingsOpen(true)
            setNotificationsOpen(false)
            setNotificationSettingsError('')
          }}
        ><Settings2 size={19} /></button>
        <span className="avatar avatar-profile">{(user?.user_metadata?.username || user?.email || '?').slice(0, 1).toUpperCase()}</span>
      </aside>
      <NotificationCenter
        open={notificationsOpen}
        loading={loadingNotifications}
        error={notificationsError}
        notifications={notificationPreferences.in_app_enabled ? notifications : []}
        unreadCount={notificationPreferences.in_app_enabled ? unreadNotificationCount : 0}
        onClose={() => setNotificationsOpen(false)}
        onMarkRead={markNotificationRead}
        onMarkAllRead={markAllNotificationsRead}
        onActivate={activateNotification}
      />
      <NotificationSettings
        open={notificationSettingsOpen}
        values={notificationPreferences}
        loading={notificationSettingsLoading}
        error={notificationSettingsError}
        browserSupported={browserSupported}
        pushConfigured={pushConfigured}
        browserPermission={browserPermission}
        onChange={updateNotificationPreference}
        onEnableBrowser={enableBrowserNotifications}
        onDisableBrowser={disableBrowserNotifications}
        onClose={() => setNotificationSettingsOpen(false)}
      />
      <section className="conversation-panel">
        <header className="panel-header">
          <div><span className="eyebrow">YOUR SPACE</span><h1>Messages</h1></div>
          <div className="mobile-notification-controls">
            <button type="button" className="icon-button mobile-notification-button" onClick={() => {
              setNotificationsOpen((open) => !open)
              setNotificationSettingsOpen(false)
              if (!notificationsOpen) loadNotifications()
            }} aria-label="Notifications" title="Notifications">
              <Bell size={18} />
              {notificationPreferences.in_app_enabled && unreadNotificationCount > 0 && <span className="mobile-notification-badge">{unreadNotificationCount > 99 ? '99+' : unreadNotificationCount}</span>}
            </button>
            <button type="button" className="icon-button" onClick={() => {
              setNotificationSettingsOpen(true)
              setNotificationsOpen(false)
              setNotificationSettingsError('')
            }} aria-label="Notification settings" title="Notification settings"><Settings2 size={18} /></button>
          </div>
          <button
            className="icon-button"
            aria-label="Start a private conversation"
            title="Start a private conversation"
            onClick={() => {
              setShowNewChat(true)
              setLookupResult(null)
              setInvitationError('')
              setInvitationNotice('')
            }}
          ><SquarePen size={19} /></button>
          <button
            className="icon-button group-create-button"
            aria-label="Create a group"
            title="Create a group"
            onClick={() => setShowGroupCreate(true)}
          ><Users size={19} /></button>
        </header>
        <label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" /></label>
        <div className="conversation-heading"><span>Recent</span><span>{filteredConversations.length}</span></div>
        <div className="conversation-list">
          {invitationNotice && <p className="invite-notice" role="status">{invitationNotice}</p>}
          {invitationError && <p className="invite-error" role="alert">{invitationError}</p>}
          {invitations.length > 0 && (
            <section className="incoming-invitations" aria-label="Incoming invitations">
              <h2>Invitations <span>{invitations.length}</span></h2>
              {invitations.map((invitation) => (
                <article className="invitation-card" id={`invitation-${invitation.invitation_id}`} key={invitation.invitation_id}>
                  <div className="invitation-copy">
                    <strong>{invitation.inviter_display_name || invitation.inviter_username}</strong>
                    <small>@{invitation.inviter_username} invited you</small>
                  </div>
                  <div className="invitation-actions">
                    <button
                      type="button"
                      className="invitation-accept"
                      onClick={() => handleInvitationResponse(invitation.invitation_id, 'accept')}
                      disabled={Boolean(respondingInvitationId)}
                    >{respondingInvitationId === invitation.invitation_id ? '…' : 'Accept'}</button>
                    <button
                      type="button"
                      className="invitation-reject"
                      onClick={() => handleInvitationResponse(invitation.invitation_id, 'reject')}
                      disabled={Boolean(respondingInvitationId)}
                    >Decline</button>
                  </div>
                </article>
              ))}
            </section>
          )}
          {loadingConversations ? (
            <div className="conversation-skeleton-list" role="status" aria-label="Loading conversations" aria-busy="true">
              {Array.from({ length: 5 }, (_, index) => (
                <div className="conversation-skeleton" key={index} aria-hidden="true">
                  <span className="skeleton-avatar" />
                  <span className="skeleton-copy"><i /><i /></span>
                </div>
              ))}
            </div>
          ) : filteredConversations.length ? filteredConversations.map((conversation) => (
            <button className={`conversation-item${activeId === conversation.id ? ' conversation-active' : ''}${unreadCounts[conversation.id] ? ' conversation-unread' : ''}`} key={conversation.id} onClick={() => openConversation(conversation.id)}>
              {conversation.avatar_url
                ? <img className="avatar group-avatar-image" src={conversation.avatar_url} alt="" />
                : <span className="avatar avatar-lavender">{(conversation.title || 'P').slice(0, 1).toUpperCase()}</span>}
              <span className="conversation-copy"><strong>{conversation.title || 'Private conversation'}</strong><small>{conversation.kind === 'private' ? 'One-to-one' : `Group · ${conversation.member_count} members${conversation.muted ? ' · muted' : ''}`}</small></span>
              <span className="conversation-meta"><small>{formatTime(conversation.updated_at)}</small>{unreadCounts[conversation.id] > 0 && <span className="conversation-unread-badge" aria-label={`${unreadCounts[conversation.id]} unread messages`}>{unreadCounts[conversation.id] > 99 ? '99+' : unreadCounts[conversation.id]}</span>}</span>
            </button>
          )) : (
            <p className="no-results">{query ? 'No conversations match that search.' : 'No conversations are available yet.'}</p>
          )}
        </div>
        {!loadingConversations && <div className="panel-bottom-note"><span><i /> Private and group chats</span><small>{conversations.length} total</small></div>}
        <div className="profile-card">
          <span className="avatar avatar-profile">{(user?.user_metadata?.username || user?.email || '?').slice(0, 1).toUpperCase()}</span>
          <span><strong>{user?.user_metadata?.username || 'Your profile'}</strong><small>{user?.email}</small>{logoutError && <small className="profile-error" role="alert">{logoutError}</small>}</span>
          <button className="profile-signout" type="button" onClick={handleSignOut} aria-label="Sign out" title="Sign out"><LogOut size={16} /></button>
        </div>
      </section>
      {showNewChat && (
        <div className="new-chat-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShowNewChat(false)
        }}>
          <section className="new-chat-dialog" role="dialog" aria-modal="true" aria-labelledby="new-chat-title">
            <header className="new-chat-heading">
              <div><span className="eyebrow">PRIVATE CONVERSATION</span><h2 id="new-chat-title">Find someone.</h2></div>
              <button type="button" className="icon-button" onClick={() => setShowNewChat(false)} aria-label="Close new conversation">×</button>
            </header>
            <p className="new-chat-description">Search by exact username. Only the matching username and display name are shown.</p>
            <form className="new-chat-search" onSubmit={handleLookup}>
              <label className="field">
                <span>Username</span>
                <span className="input-wrap"><Search size={17} /><input
                  value={usernameSearch}
                  onChange={(event) => setUsernameSearch(event.target.value)}
                  placeholder="e.g. maya_chen"
                  autoComplete="off"
                  minLength={3}
                  maxLength={32}
                  pattern="[a-zA-Z0-9_]{3,32}"
                  required
                  autoFocus
                /></span>
              </label>
              <button className="button button-primary" type="submit" disabled={lookupLoading}>
                {lookupLoading && <LoaderCircle className="loading-icon" size={15} />}
                {lookupLoading ? 'Searching…' : 'Search'}
              </button>
            </form>
            {invitationError && <p className="form-notice" role="alert">{invitationError}</p>}
            {invitationNotice && <p className="form-notice form-notice-success" role="status">{invitationNotice}</p>}
            {lookupResult && (
              <div className="user-lookup-result">
                <span className="avatar avatar-lavender">{(lookupResult.display_name || lookupResult.username).slice(0, 1).toUpperCase()}</span>
                <span className="lookup-copy">
                  <strong>{lookupResult.display_name || lookupResult.username}</strong>
                  <small>@{lookupResult.username}</small>
                </span>
                {lookupResult.relationship === 'existing' ? (
                  <button className="lookup-action" type="button" onClick={() => {
                    setShowNewChat(false)
                    openConversation(lookupResult.conversation_id)
                  }}>Open chat</button>
                ) : lookupResult.relationship === 'invitation_sent' ? (
                  <span className="lookup-state">Invitation sent</span>
                ) : lookupResult.relationship === 'invitation_received' ? (
                  <span className="lookup-state">See incoming invite</span>
                ) : (
                  <button className="lookup-action" type="button" onClick={handleInvite} disabled={invitationSending}>
                    {invitationSending ? 'Sending…' : lookupResult.relationship === 'invitation_rejected' ? 'Invite again' : 'Invite'}
                  </button>
                )}
              </div>
            )}
            <p className="username-privacy-note">Username search is exact and rate-limited. Email addresses are never revealed.</p>
          </section>
        </div>
      )}
      {showGroupCreate && (
        <GroupCreateDialog
          onClose={() => setShowGroupCreate(false)}
          onCreated={openCreatedGroup}
        />
      )}
      <section className="conversation-view">
        {activeConversation ? (
          <>
            <header className="chat-header">
              <button className="mobile-back icon-button" onClick={() => {
                stopTyping(activeId)
                setShowMobileConversation(false)
              }} aria-label="Back to conversations"><ArrowLeft size={19} /></button>
              {activeConversation.avatar_url
                ? <img className="avatar avatar-small group-avatar-image" src={activeConversation.avatar_url} alt="" />
                : <span className="avatar avatar-lavender avatar-small">{(activeConversation.title || 'P').slice(0, 1).toUpperCase()}</span>}
              <div className="chat-header-copy">
                <strong>{activeConversation.title || 'Private conversation'}</strong>
                <small className="presence-status" role="status" aria-live="polite">
                  {activeConversation.kind === 'group'
                    ? typingUserId
                      ? `${groupMemberName(typingUserId)} is typing…`
                      : `${activeConversation.member_count || groupMembers.length} members`
                    : <>
                      <i className={`presence-dot${partnerOnline ? ' presence-online' : ''}`} />
                      {typingUserId
                        ? `${partnerDisplayName} is typing…`
                        : partnerOnline === null
                          ? connection === 'connected'
                            ? 'Checking status…'
                            : connection === 'reconnecting'
                              ? 'Reconnecting…'
                              : connection === 'disconnected'
                                ? 'Status unavailable'
                                : 'Connecting…'
                          : partnerOnline ? 'Online' : 'Offline'}
                    </>}
                </small>
              </div>
              <button
                type="button"
                className={`icon-button chat-search-toggle${searchOpen ? ' chat-search-active' : ''}`}
                onClick={() => {
                  setSearchOpen((open) => !open)
                  setMessageSearch('')
                  setSearchError('')
                  setSearchResults([])
                  setSearchHasMore(false)
                  setSearchLoading(false)
                }}
                aria-label={searchOpen ? 'Close message search' : 'Search messages'}
                title="Search messages"
              ><Search size={18} /></button>
              {activeConversation.kind === 'group'
                ? <button className="icon-button chat-more" aria-label="Group information and members" title="Group information and members" onClick={() => setShowGroupDetails(true)}><Users size={19} /></button>
                : <button className="icon-button chat-more" aria-label="Conversation options unavailable" title="Calls and conversation options are not connected" disabled><MoreHorizontal size={20} /></button>}
            </header>
            {searchOpen && (
              <section className="message-search-panel" aria-label="Search messages">
                <div className="message-search-input">
                  <Search size={16} aria-hidden="true" />
                  <input
                    value={messageSearch}
                    onChange={(event) => {
                      setMessageSearch(event.target.value.slice(0, 120))
                      setSearchResults([])
                      setSearchHasMore(false)
                      setSearchLoading(false)
                      setSearchError('')
                    }}
                    placeholder="Search in this conversation"
                    aria-label="Search message text"
                    autoFocus
                  />
                  <button type="button" className="icon-button" onClick={() => {
                    setSearchOpen(false)
                    setMessageSearch('')
                  }} aria-label="Close search"><X size={16} /></button>
                </div>
                <div className="message-search-results" aria-live="polite">
                  {searchLoading ? <p className="search-status"><LoaderCircle className="loading-icon" size={15} /> Searching…</p>
                    : searchError ? <p className="search-status search-error" role="alert">{searchError}</p>
                      : !messageSearch.trim() ? <p className="search-status">Search message text in this conversation.</p>
                        : searchResults.length ? searchResults.map((result) => (
                          <button
                            type="button"
                            className="message-search-result"
                            key={result.id}
                            onClick={() => navigateToMessage(result.id)}
                          >
                            <span>{result.message_type === 'text' ? highlightMatch(result.body, messageSearch.trim()) : result.attachment_name}</span>
                            <small>{formatTime(result.created_at)}</small>
                          </button>
                        )) : <p className="search-status"><SearchX size={15} /> No matching messages.</p>}
                  {!searchLoading && searchHasMore && <small className="search-limit-note">Showing the 40 most recent matches.</small>}
                </div>
              </section>
            )}
            <div className="sample-banner"><CircleHelp size={14} /> Messages are visible only to conversation members.</div>
            <div
              className="message-thread"
              aria-live="polite"
              ref={threadRef}
              aria-busy={loadingMessages}
              onScroll={(event) => {
                const thread = event.currentTarget
                shouldScrollToBottom.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80
              }}
            >
              {hasOlder && <button className="load-older" type="button" onClick={loadOlderMessages} disabled={loadingOlder}>{loadingOlder ? 'Loading older messages…' : 'Load older messages'}</button>}
              {loadingMessages ? (
                <div className="message-skeleton-list" role="status" aria-label="Loading message history">
                  <span className="visually-hidden">Loading message history…</span>
                  <i className="message-skeleton" aria-hidden="true" />
                  <i className="message-skeleton message-skeleton-mine" aria-hidden="true" />
                  <i className="message-skeleton message-skeleton-short" aria-hidden="true" />
                  <i className="message-skeleton message-skeleton-mine message-skeleton-medium" aria-hidden="true" />
                </div>
              ) : messages.length ? messages.map((message) => {
                const mine = message.sender_id === user.id
                const senderName = activeConversation.kind === 'group'
                  ? message.sender_id === user.id ? 'You' : groupMemberName(message.sender_id)
                  : partnerDisplayName
                const replySender = message.reply?.sender_id === user.id
                  ? 'You'
                  : activeConversation.kind === 'group'
                    ? groupMemberName(message.reply?.sender_id)
                    : partnerDisplayName
                return (
                  <div
                    className={`message-row${mine ? ' message-mine' : ''}${highlightMessageId === message.id ? ' message-highlight' : ''}${message.id === firstUnreadMessageId ? ' message-first-unread' : ''}`}
                    key={message.id}
                    ref={(element) => {
                      if (element) messageRefs.current.set(message.id, element)
                      else messageRefs.current.delete(message.id)
                    }}
                  >
                    {message.id === firstUnreadMessageId && <div className="unread-divider"><span />Unread messages<span /></div>}
                    <div className={`message-bubble${mine ? ' message-bubble-mine' : ''}${message.pending ? ' message-pending' : ''}`}>
                      {activeConversation.kind === 'group' && !mine && (
                        <div className="group-message-sender">
                          {groupMembersById.get(message.sender_id)?.avatar_url
                            ? <img className="group-message-avatar" src={groupMembersById.get(message.sender_id).avatar_url} alt="" />
                            : <span className="group-message-avatar">{senderName.slice(0, 1).toUpperCase()}</span>}
                          <strong>{senderName}</strong>
                        </div>
                      )}
                      {message.reply_to_id && (
                        <button
                          type="button"
                          className="reply-preview"
                          onClick={() => message.reply && navigateToMessage(message.reply.id)}
                          disabled={!message.reply}
                          aria-label={message.reply ? `Go to reply from ${replySender}` : 'Original message unavailable'}
                        >
                          <strong>{message.reply ? replySender : 'Original message unavailable'}</strong>
                          <span>{message.reply
                            ? message.reply.deleted_at
                              ? 'This message is unavailable'
                              : message.reply.message_type !== 'text'
                                ? message.reply.attachment_name || 'Attachment'
                                : message.reply.body
                            : 'This message may have been deleted.'}</span>
                        </button>
                      )}
                      {message.deleted_at ? (
                        <p className="deleted-message">This message is unavailable.</p>
                      ) : message.message_type === 'image' || message.message_type === 'file' ? (
                        <>
                          {!message.pending && <MessageAttachment message={message} />}
                          {message.pending && <span className="attachment-pending">{message.attachment_name}</span>}
                          {message.body !== message.attachment_name && <p>{message.body}</p>}
                        </>
                      ) : <p>{message.body}</p>}
                      <small>
                        {message.pending ? 'Sending…' : formatTime(message.created_at)}
                        {mine && !message.pending && (
                          <span
                            className="message-receipt"
                            role="img"
                            aria-label={activeConversation.kind === 'group' && message.read
                              ? `Read by ${message.read_count || 1} group member${(message.read_count || 1) === 1 ? '' : 's'}`
                              : message.read ? 'Read' : 'Sent'}
                            title={activeConversation.kind === 'group' && message.read
                              ? `Read by ${message.read_count || 1} of ${message.recipient_count || activeConversation.member_count - 1} members`
                              : message.read ? 'Read' : 'Sent'}
                          >
                            {message.read ? <CheckCheck size={12} /> : <Check size={12} />}
                          </span>
                        )}
                      </small>
                      <div className="message-actions">
                        <button type="button" onClick={() => setReplyTarget(message)} aria-label="Reply to message" title="Reply"><MessageSquareReply size={14} /></button>
                        <button type="button" onClick={() => copyMessage(message.body)} aria-label="Copy message text" title="Copy message"><Copy size={14} /></button>
                        <button type="button" onClick={() => setReactionPickerMessageId((current) => current === message.id ? null : message.id)} aria-label="React to message" title="Add a reaction"><SmilePlus size={14} /></button>
                      </div>
                      {message.reactions?.length > 0 && (
                        <div className="message-reactions" aria-label="Message reactions">
                          {message.reactions.map((entry) => (
                            <button
                              type="button"
                              key={entry.reaction}
                              className={`reaction-chip${entry.mine ? ' reaction-selected' : ''}`}
                              onClick={() => toggleReaction(message, entry.reaction)}
                              aria-label={`${entry.reaction}, ${entry.count} reactions`}
                              aria-pressed={entry.mine}
                              title={`${entry.reaction} · ${entry.count}`}
                            >{entry.reaction}<span>{entry.count}</span></button>
                          ))}
                        </div>
                      )}
                      {reactionPickerMessageId === message.id && (
                        <div className="reaction-picker" aria-label="Choose a reaction">
                          {['👍', '❤️', '😂', '😮', '😢', '🙏'].map((reaction) => (
                            <button type="button" key={reaction} onClick={() => {
                              toggleReaction(message, reaction)
                              setReactionPickerMessageId(null)
                            }} aria-label={`React with ${reaction}`} title={reaction}>{reaction}</button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )
              }) : (
                <div className="thread-status">No messages yet. Start the conversation when you’re ready.</div>
              )}
              {typingUserId && (
                <p className="typing-indicator" role="status" aria-live="polite">
                  <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
                  {activeConversation.kind === 'group' ? groupMemberName(typingUserId) : partnerDisplayName} is typing…
                </p>
              )}
            </div>
            {error && <div className="chat-notice" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
            {replyTarget && (
              <div className="reply-composer-preview">
                <span><strong>Replying to {replyTarget.sender_id === user.id ? 'yourself' : activeConversation.kind === 'group' ? groupMemberName(replyTarget.sender_id) : partnerDisplayName}</strong><small>{replyTarget.message_type === 'text' ? replyTarget.body : replyTarget.attachment_name || 'Attachment'}</small></span>
                <button type="button" onClick={() => setReplyTarget(null)} aria-label="Cancel reply"><X size={16} /></button>
              </div>
            )}
            {pendingAttachment && (
              <div className="attachment-preview">
                {pendingAttachment.metadata.type === 'image'
                  ? <img className="attachment-preview-image" ref={setAttachmentPreviewElement} alt={`Preview of ${pendingAttachment.file.name}`} />
                  : <span className="attachment-file-icon"><FileText size={17} /></span>}
                <span className="attachment-file-copy"><strong>{pendingAttachment.file.name}</strong><small>{formatFileSize(pendingAttachment.file.size)}{sending ? ` · Uploading ${uploadProgress}%` : ''}</small></span>
                {sending && <span className="upload-progress" role="status">{uploadProgress}%</span>}
                <button type="button" className="icon-button" onClick={cancelUpload} aria-label={sending ? 'Cancel upload' : 'Remove attachment'}><X size={16} /></button>
              </div>
            )}
            <form className="composer" onSubmit={handleSend}>
              <input
                ref={fileInputRef}
                className="visually-hidden"
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={chooseAttachment}
                tabIndex="-1"
                aria-label="Choose image or document"
              />
              <button type="button" className="composer-icon" aria-label="Attach image or file" title="Attach image or file" onClick={() => fileInputRef.current?.click()} disabled={sending || Boolean(pendingAttachment)}><Paperclip size={19} /></button>
              <input value={draft} onChange={(event) => handleDraftChange(event.target.value)} aria-label="Message" placeholder="Write a message…" maxLength={20000} disabled={loadingMessages || sending} />
              <span className="message-length">{[...draft].length}/10000</span>
              <button type="button" className="composer-icon composer-emoji" aria-label="Emoji picker unavailable" title="Emoji picker is not available" disabled><Smile size={19} /></button>
              <button type="submit" className="send-button" aria-label="Send message" title="Send message" disabled={sending || (!draft.trim() && !pendingAttachment) || connection !== 'connected'}><Send size={17} /></button>
            </form>
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-art"><div className="empty-orbit orbit-one" /><div className="empty-orbit orbit-two" /><span><MessageCircle size={32} /></span></div>
            <span className="eyebrow">A LITTLE SPACE TO BREATHE</span>
            <h2>{conversations.length ? <>Your next good<br />conversation starts here.</> : <>Your conversations<br />will feel right at home.</>}</h2>
            <p>{conversations.length ? 'Choose a private conversation or group to see history and send messages.' : 'No conversations yet. Start a private chat or create a group to bring people together.'}</p>
            {!conversations.length && <button className="button button-primary empty-select" type="button" onClick={() => setShowGroupCreate(true)}><Users size={16} /> Create a group</button>}
            {!conversations.length && <button className="button button-quiet empty-select" type="button" onClick={loadConversations}><Plus size={16} /> Refresh conversations</button>}
            <span className="empty-disclaimer">{connectionText} · conversation members only</span>
            {error && <p className="chat-page-error" role="alert">{error}</p>}
          </div>
        )}
      </section>
      {showGroupDetails && activeConversation?.kind === 'group' && (
        <GroupDetailsPanel
          key={`${activeConversation.id}:${activeConversation.title}:${activeConversation.description}:${activeConversation.avatar_url}`}
          conversation={activeConversation}
          onClose={() => setShowGroupDetails(false)}
          onChanged={() => {
            loadConversations()
            messagingRequest(`/groups/${activeConversation.id}/members`)
              .then((result) => setGroupMembers(result.members || []))
              .catch((membersError) => setError(membersError.message))
          }}
          onLeft={() => {
            setShowGroupDetails(false)
            activeIdRef.current = null
            setActiveId(null)
            setMessages([])
            setGroupMembers([])
            setShowMobileConversation(false)
            loadConversations()
          }}
          onMembersChange={updateGroupMembers}
        />
      )}
    </main>
  )
}
