import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { ArrowLeft, Bell, Check, CircleHelp, LoaderCircle, LogOut, MessageCircle, MoreHorizontal, Paperclip, Plus, Search, Send, Settings2, Smile, SquarePen, Users } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/useAuth.js'
import { getAccessToken, getSocketUrl, messagingRequest } from '../lib/messaging.js'
import { supabase } from '../lib/supabase.js'
import Brand from '../components/common/Brand.jsx'

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

export default function ChatPage() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
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
  const [error, setError] = useState('')
  const [logoutError, setLogoutError] = useState('')
  const [showMobileConversation, setShowMobileConversation] = useState(false)
  const [showNewChat, setShowNewChat] = useState(false)
  const [usernameSearch, setUsernameSearch] = useState('')
  const [lookupResult, setLookupResult] = useState(null)
  const [lookupLoading, setLookupLoading] = useState(false)
  const [invitationSending, setInvitationSending] = useState(false)
  const [respondingInvitationId, setRespondingInvitationId] = useState('')
  const [invitationNotice, setInvitationNotice] = useState('')
  const [invitationError, setInvitationError] = useState('')
  const socketRef = useRef(null)
  const activeIdRef = useRef(null)
  const threadRef = useRef(null)
  const shouldScrollToBottom = useRef(true)
  const olderScrollPosition = useRef(null)

  const activeConversation = conversations.find((conversation) => conversation.id === activeId)
  const filteredConversations = useMemo(() => conversations.filter((conversation) => (
    (conversation.title || 'Private conversation').toLowerCase().includes(query.toLowerCase())
  )), [conversations, query])

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

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadConversations()
      loadInvitations()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadConversations, loadInvitations, user?.id])

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
      const conversationId = activeIdRef.current
      if (conversationId) {
        socket.emit('conversation:join', { conversationId }, (result) => {
          if (!result?.ok) setError(result?.error || 'Could not join this conversation.')
        })
      }
    })
    socket.on('disconnect', (reason) => {
      setConnection(reason === 'io client disconnect' ? 'disconnected' : 'reconnecting')
    })
    socket.on('connect_error', (connectError) => {
      setConnection('disconnected')
      setError(connectError.message || 'Real-time connection failed. Retrying…')
    })
    socket.io.on('reconnect_attempt', () => setConnection('reconnecting'))
    socket.on('message:new', ({ message, clientId }) => {
      if (message?.conversation_id !== activeIdRef.current) return
      setMessages((current) => mergeMessage(current, message, clientId))
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
  }, [user?.id])

  useEffect(() => {
    const socket = socketRef.current
    if (!socket) return undefined
    if (activeId && socket.connected) {
      socket.emit('conversation:join', { conversationId: activeId }, (result) => {
        if (!result?.ok) setError(result?.error || 'Could not join this conversation.')
      })
    }
    return () => {
      if (activeId && socket.connected) socket.emit('conversation:leave', { conversationId: activeId })
    }
  }, [activeId])

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

  function openConversation(conversationId) {
    activeIdRef.current = conversationId
    shouldScrollToBottom.current = true
    olderScrollPosition.current = null
    setActiveId(conversationId)
    setMessages([])
    setCursor(null)
    setHasOlder(false)
    setLoadingMessages(true)
    setError('')
    setShowMobileConversation(true)
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

  function handleSend(event) {
    event.preventDefault()
    const body = draft.trim()
    if (!body || sending) return
    if ([...body].length > 10000) {
      setError('Messages cannot exceed 10,000 characters.')
      return
    }
    const socket = socketRef.current
    if (!socket?.connected) {
      setError('You are offline. Reconnect before sending your message.')
      return
    }

    const clientId = crypto.randomUUID()
    const optimisticMessage = {
      id: `pending-${clientId}`,
      clientId,
      conversation_id: activeId,
      sender_id: user.id,
      body,
      created_at: new Date().toISOString(),
      pending: true,
    }
    setMessages((current) => [...current, optimisticMessage])
    setDraft('')
    setSending(true)
    setError('')
    socket.timeout(15000).emit(
      'message:send',
      { conversationId: activeId, body, clientId },
      (timeoutError, result) => {
        setSending(false)
        if (timeoutError || !result?.ok) {
          setMessages((current) => current.filter((message) => message.clientId !== clientId))
          setError(result?.error || 'Message sending timed out. Check your connection and try again.')
          setDraft(body)
          return
        }
        setMessages((current) => mergeMessage(current, result.message, clientId))
      },
    )
  }

  async function handleSignOut() {
    setLogoutError('')
    try {
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

  return (
    <main className={`messenger${showMobileConversation ? ' mobile-conversation-open' : ''}`}>
      <aside className="app-rail">
        <Brand compact />
        <button className="rail-action rail-action-active" aria-label="Messages"><MessageCircle size={19} /></button>
        <button className="rail-action" aria-label="Groups are not available yet" title="Groups are not available yet" disabled><Users size={19} /></button>
        <div className="rail-spacer" />
        <button className="rail-action" aria-label="Notifications are not available yet" title="Notifications are not available yet" disabled><Bell size={18} /></button>
        <button className="rail-action" aria-label="Settings are not available yet" title="Settings are not available yet" disabled><Settings2 size={19} /></button>
        <span className="avatar avatar-profile">{(user?.user_metadata?.username || user?.email || '?').slice(0, 1).toUpperCase()}</span>
      </aside>
      <section className="conversation-panel">
        <header className="panel-header">
          <div><span className="eyebrow">YOUR SPACE</span><h1>Messages</h1></div>
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
                <article className="invitation-card" key={invitation.invitation_id}>
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
            <p className="list-status"><LoaderCircle className="loading-icon" size={15} /> Loading conversations…</p>
          ) : filteredConversations.length ? filteredConversations.map((conversation) => (
            <button className={`conversation-item${activeId === conversation.id ? ' conversation-active' : ''}`} key={conversation.id} onClick={() => openConversation(conversation.id)}>
              <span className="avatar avatar-lavender">{(conversation.title || 'P').slice(0, 1).toUpperCase()}</span>
              <span className="conversation-copy"><strong>{conversation.title || 'Private conversation'}</strong><small>{conversation.kind === 'private' ? 'One-to-one' : 'Group'}</small></span>
              <span className="conversation-meta"><small>{formatTime(conversation.updated_at)}</small></span>
            </button>
          )) : (
            <p className="no-results">{query ? 'No conversations match that search.' : 'No conversations are available yet.'}</p>
          )}
        </div>
        {!loadingConversations && <div className="panel-bottom-note"><span><i /> Private conversations</span><small>{conversations.length} total</small></div>}
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
      <section className="conversation-view">
        {activeConversation ? (
          <>
            <header className="chat-header">
              <button className="mobile-back icon-button" onClick={() => setShowMobileConversation(false)} aria-label="Back to conversations"><ArrowLeft size={19} /></button>
              <span className="avatar avatar-lavender avatar-small">{(activeConversation.title || 'P').slice(0, 1).toUpperCase()}</span>
              <div className="chat-header-copy"><strong>{activeConversation.title || 'Private conversation'}</strong><small><i className={`connection-dot connection-${connection}`} /> {connectionText}</small></div>
              <button className="icon-button chat-more" aria-label="Conversation options unavailable" title="Calls and conversation options are not connected" disabled><MoreHorizontal size={20} /></button>
            </header>
            <div className="sample-banner"><CircleHelp size={14} /> Messages are visible only to conversation members.</div>
            <div
              className="message-thread"
              aria-live="polite"
              ref={threadRef}
              onScroll={(event) => {
                const thread = event.currentTarget
                shouldScrollToBottom.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80
              }}
            >
              {hasOlder && <button className="load-older" type="button" onClick={loadOlderMessages} disabled={loadingOlder}>{loadingOlder ? 'Loading older messages…' : 'Load older messages'}</button>}
              {loadingMessages ? (
                <div className="thread-status"><LoaderCircle className="loading-icon" size={18} /> Loading message history…</div>
              ) : messages.length ? messages.map((message) => {
                const mine = message.sender_id === user.id
                return (
                  <div className={`message-row${mine ? ' message-mine' : ''}`} key={message.id}>
                    <div className={`message-bubble${mine ? ' message-bubble-mine' : ''}${message.pending ? ' message-pending' : ''}`}>
                      <p>{message.body}</p>
                      <small>{message.pending ? 'Sending…' : formatTime(message.created_at)}{mine && !message.pending && <Check size={12} />}</small>
                    </div>
                  </div>
                )
              }) : (
                <div className="thread-status">No messages yet. Start the conversation when you’re ready.</div>
              )}
            </div>
            {error && <div className="chat-notice" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
            <form className="composer" onSubmit={handleSend}>
              <button type="button" className="composer-icon" aria-label="Attachments are not available" title="Attachments are not in this phase" disabled><Paperclip size={19} /></button>
              <input value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="Message" placeholder="Write a message…" maxLength={20000} disabled={loadingMessages} />
              <span className="message-length">{[...draft].length}/10000</span>
              <button type="button" className="composer-icon composer-emoji" aria-label="Emoji picker unavailable" title="Emoji picker is not available" disabled><Smile size={19} /></button>
              <button type="submit" className="send-button" aria-label="Send message" title="Send message" disabled={sending || !draft.trim() || connection !== 'connected'}><Send size={17} /></button>
            </form>
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-art"><div className="empty-orbit orbit-one" /><div className="empty-orbit orbit-two" /><span><MessageCircle size={32} /></span></div>
            <span className="eyebrow">A LITTLE SPACE TO BREATHE</span>
            <h2>{conversations.length ? <>Your next good<br />conversation starts here.</> : <>Your conversations<br />will feel right at home.</>}</h2>
            <p>{conversations.length ? 'Choose an existing private conversation to see history and send messages.' : 'No authorized conversations were found. Starting a private chat requires the secure invitation policy that is not in the applied database migration.'}</p>
            {!conversations.length && <button className="button button-quiet empty-select" type="button" onClick={loadConversations}><Plus size={16} /> Refresh conversations</button>}
            <span className="empty-disclaimer">{connectionText} · private messages only</span>
            {error && <p className="chat-page-error" role="alert">{error}</p>}
          </div>
        )}
      </section>
    </main>
  )
}
