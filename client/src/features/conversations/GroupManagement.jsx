import { useCallback, useEffect, useState } from 'react'
import { Check, LoaderCircle, Search, Shield, UserMinus, UserPlus, Users, X } from 'lucide-react'
import { messagingRequest } from '../../lib/messaging.js'

const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/i

function Avatar({ url, name, className = '' }) {
  return url
    ? <img className={`avatar group-avatar-image ${className}`} src={url} alt="" />
    : <span className={`avatar avatar-lavender ${className}`}>{(name || 'G').slice(0, 1).toUpperCase()}</span>
}

export function GroupCreateDialog({ onClose, onCreated }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  const [username, setUsername] = useState('')
  const [candidate, setCandidate] = useState(null)
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function searchUser(event) {
    event?.preventDefault()
    const term = username.trim()
    if (!USERNAME_PATTERN.test(term)) {
      setError('Enter an exact username with 3 to 32 letters, numbers, or underscores.')
      return
    }
    setLoading(true)
    setError('')
    setCandidate(null)
    try {
      const result = await messagingRequest(`/groups/users/lookup?username=${encodeURIComponent(term)}`)
      setCandidate(result)
    } catch (lookupError) {
      setError(lookupError.message)
    } finally {
      setLoading(false)
    }
  }

  function addCandidate() {
    if (!candidate || members.some((member) => member.user_id === candidate.user_id)) return
    setMembers((current) => [...current, candidate])
    setCandidate(null)
    setUsername('')
  }

  async function createGroup(event) {
    event.preventDefault()
    if (members.length < 1) {
      setError('Add at least one other Textovert user to create a group.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const result = await messagingRequest('/groups', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description,
          avatarUrl: avatarUrl.trim() || null,
          memberIds: members.map((member) => member.user_id),
        }),
      })
      onCreated(result.conversationId)
      onClose()
    } catch (createError) {
      setError(createError.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="new-chat-overlay group-dialog-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose()
    }}>
      <section className="new-chat-dialog group-dialog" role="dialog" aria-modal="true" aria-labelledby="create-group-title">
        <header className="new-chat-heading">
          <div><span className="eyebrow">GROUP CHAT</span><h2 id="create-group-title">Bring people together.</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close group creation"><X size={18} /></button>
        </header>
        <p className="new-chat-description">Choose a name and add existing Textovert users by their exact username.</p>
        <form className="group-form" onSubmit={createGroup}>
          <label className="field">
            <span>Group name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required />
          </label>
          <label className="field">
            <span>Description <small>Optional</small></span>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} rows={2} />
          </label>
          <label className="field">
            <span>Avatar image URL <small>Optional · HTTPS</small></span>
            <input type="url" value={avatarUrl} onChange={(event) => setAvatarUrl(event.target.value)} placeholder="https://…" />
          </label>
          <div className="group-member-search">
            <label className="field">
              <span>Add members</span>
              <span className="input-wrap"><Search size={16} /><input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                minLength={3}
                maxLength={32}
                pattern="[a-zA-Z0-9_]{3,32}"
                autoComplete="off"
                placeholder="Search username"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    searchUser()
                  }
                }}
              /></span>
            </label>
            <button type="button" className="button button-quiet" disabled={loading} onClick={searchUser}>
              {loading ? <LoaderCircle className="loading-icon" size={14} /> : <Search size={14} />}
              Search
            </button>
          </div>
          {candidate && (
            <div className="group-candidate">
              <Avatar url={candidate.avatar_url} name={candidate.display_name || candidate.username} />
              <span><strong>{candidate.display_name || candidate.username}</strong><small>@{candidate.username}</small></span>
              <button type="button" className="lookup-action" onClick={addCandidate} disabled={members.some((item) => item.user_id === candidate.user_id)}>
                {members.some((item) => item.user_id === candidate.user_id) ? 'Added' : 'Add'}
              </button>
            </div>
          )}
          {members.length > 0 && (
            <div className="group-selected-members" aria-label="Selected group members">
              {members.map((member) => (
                <span className="group-member-chip" key={member.user_id}>
                  {member.display_name || member.username}
                  <button type="button" onClick={() => setMembers((current) => current.filter((entry) => entry.user_id !== member.user_id))} aria-label={`Remove ${member.username}`}>×</button>
                </span>
              ))}
            </div>
          )}
          {error && <p className="form-notice" role="alert">{error}</p>}
          <footer className="group-dialog-actions">
            <small>{members.length} member{members.length === 1 ? '' : 's'} selected · You’ll be the admin</small>
            <button className="button button-primary" type="submit" disabled={saving || members.length < 1}>
              {saving && <LoaderCircle className="loading-icon" size={15} />}
              {saving ? 'Creating…' : 'Create group'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}

export function GroupDetailsPanel({
  conversation,
  onClose,
  onChanged,
  onLeft,
  onMembersChange,
}) {
  const [members, setMembers] = useState([])
  const [name, setName] = useState(conversation.title || '')
  const [description, setDescription] = useState(conversation.description || '')
  const [avatarUrl, setAvatarUrl] = useState(conversation.avatar_url || '')
  const [username, setUsername] = useState('')
  const [candidate, setCandidate] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const isAdmin = conversation.my_role === 'admin'

  const loadMembers = useCallback(async () => {
    try {
      const result = await messagingRequest(`/groups/${conversation.id}/members`)
      const nextMembers = result.members || []
      setMembers(nextMembers)
      onMembersChange(nextMembers)
    } catch (loadError) {
      setError(loadError.message)
    } finally {
      setLoading(false)
    }
  }, [conversation.id, onMembersChange])

  useEffect(() => {
    let cancelled = false
    messagingRequest(`/groups/${conversation.id}/members`)
      .then((result) => {
        if (cancelled) return
        const nextMembers = result.members || []
        setMembers(nextMembers)
        onMembersChange(nextMembers)
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [conversation.id, onMembersChange])

  async function searchUser(event) {
    event.preventDefault()
    const term = username.trim()
    if (!USERNAME_PATTERN.test(term)) {
      setError('Enter an exact username with 3 to 32 letters, numbers, or underscores.')
      return
    }
    setBusy(true)
    setError('')
    setCandidate(null)
    try {
      setCandidate(await messagingRequest(`/groups/users/lookup?username=${encodeURIComponent(term)}`))
    } catch (lookupError) {
      setError(lookupError.message)
    } finally {
      setBusy(false)
    }
  }

  async function addMember() {
    if (!candidate || members.some((member) => member.user_id === candidate.user_id)) return
    setBusy(true)
    setError('')
    try {
      await messagingRequest(`/groups/${conversation.id}/members`, {
        method: 'POST',
        body: JSON.stringify({ memberIds: [candidate.user_id] }),
      })
      setCandidate(null)
      setUsername('')
      await loadMembers()
      onChanged()
    } catch (addError) {
      setError(addError.message)
    } finally {
      setBusy(false)
    }
  }

  async function saveDetails(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await messagingRequest(`/groups/${conversation.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, description, avatarUrl: avatarUrl.trim() || null }),
      })
      onChanged()
    } catch (saveError) {
      setError(saveError.message)
    } finally {
      setBusy(false)
    }
  }

  async function changeMember(member, action) {
    setBusy(true)
    setError('')
    try {
      if (action === 'remove' && !window.confirm(`Remove @${member.username} from this group?`)) return
      await messagingRequest(
        action === 'promote'
          ? `/groups/${conversation.id}/members/${member.user_id}/promote`
          : `/groups/${conversation.id}/members/${member.user_id}`,
        { method: action === 'promote' ? 'POST' : 'DELETE' },
      )
      await loadMembers()
      onChanged()
    } catch (memberError) {
      setError(memberError.message)
    } finally {
      setBusy(false)
    }
  }

  async function toggleMute() {
    setBusy(true)
    setError('')
    try {
      await messagingRequest(`/groups/${conversation.id}/mute`, {
        method: 'PATCH',
        body: JSON.stringify({ muted: !conversation.muted }),
      })
      onChanged()
    } catch (muteError) {
      setError(muteError.message)
    } finally {
      setBusy(false)
    }
  }

  async function leaveGroup() {
    if (!window.confirm(`Leave ${conversation.title}?`)) return
    setBusy(true)
    setError('')
    try {
      await messagingRequest(`/groups/${conversation.id}/leave`, { method: 'POST' })
      onLeft()
    } catch (leaveError) {
      setError(leaveError.message)
      setBusy(false)
    }
  }

  return (
    <div className="group-panel-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="group-details-panel" role="dialog" aria-modal="true" aria-labelledby="group-details-title">
        <header className="group-details-heading">
          <div><span className="eyebrow">GROUP INFORMATION</span><h2 id="group-details-title">Group details</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close group details"><X size={18} /></button>
        </header>
        <div className="group-details-summary">
          <Avatar url={conversation.avatar_url} name={conversation.title} />
          <span>
            <strong>{conversation.title}</strong>
            {conversation.description && <small>{conversation.description}</small>}
            <small>{members.length} members · You are {conversation.my_role}</small>
          </span>
        </div>
        <button className="group-mute-button" type="button" onClick={toggleMute} disabled={busy}>
          {conversation.muted ? 'Unmute group notifications' : 'Mute group notifications'}
        </button>
        {isAdmin && (
          <form className="group-form group-edit-form" onSubmit={saveDetails}>
            <label className="field"><span>Group name</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required /></label>
            <label className="field"><span>Description</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} rows={2} /></label>
            <label className="field"><span>Avatar image URL <small>Optional · HTTPS</small></span><input type="url" value={avatarUrl} onChange={(event) => setAvatarUrl(event.target.value)} /></label>
            <button className="button button-quiet" type="submit" disabled={busy}>Save group details</button>
          </form>
        )}
        {isAdmin && (
          <form className="group-member-search" onSubmit={searchUser}>
            <label className="field"><span>Add a member</span><span className="input-wrap"><Search size={16} /><input value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={32} pattern="[a-zA-Z0-9_]{3,32}" placeholder="Exact username" /></span></label>
            <button className="button button-quiet" type="submit" disabled={busy}><Search size={14} />Search</button>
          </form>
        )}
        {candidate && (
          <div className="group-candidate">
            <Avatar url={candidate.avatar_url} name={candidate.display_name || candidate.username} />
            <span><strong>{candidate.display_name || candidate.username}</strong><small>@{candidate.username}</small></span>
            <button
              className="lookup-action"
              type="button"
              disabled={busy || members.some((member) => member.user_id === candidate.user_id)}
              onClick={addMember}
            >
              <UserPlus size={14} />
              {members.some((member) => member.user_id === candidate.user_id) ? 'Member' : 'Add'}
            </button>
          </div>
        )}
        <div className="group-members-heading"><Users size={15} /><strong>Members</strong><span>{members.length}</span></div>
        <div className="group-members-list">
          {loading ? <p className="list-status"><LoaderCircle className="loading-icon" size={15} /> Loading members…</p> : members.map((member) => (
            <div className="group-member-row" key={member.user_id}>
              <Avatar url={member.avatar_url} name={member.display_name || member.username} />
              <span><strong>{member.display_name || member.username}</strong><small>@{member.username}</small></span>
              {member.role === 'admin'
                ? <small className="group-role"><Shield size={12} /> Admin</small>
                : isAdmin && <div className="group-member-actions">
                  <button type="button" onClick={() => changeMember(member, 'promote')} disabled={busy} aria-label={`Promote ${member.username} to admin`} title="Promote to admin"><Check size={14} /></button>
                  <button type="button" onClick={() => changeMember(member, 'remove')} disabled={busy} aria-label={`Remove ${member.username}`} title="Remove member"><UserMinus size={14} /></button>
                </div>}
            </div>
          ))}
        </div>
        {error && <p className="form-notice" role="alert">{error}</p>}
        <button className="group-leave-button" type="button" onClick={leaveGroup} disabled={busy}>Leave group</button>
      </section>
    </div>
  )
}
