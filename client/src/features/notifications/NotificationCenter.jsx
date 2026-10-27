import { Bell, Check, CheckCheck, LoaderCircle, X } from 'lucide-react'

function formatNotificationTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function describeNotification(notification) {
  if (notification.type === 'invitation') return 'sent you a conversation invitation.'
  if (notification.type === 'invitation_accepted') return 'accepted your conversation invitation.'
  return 'sent you a message.'
}

export default function NotificationCenter({
  open,
  loading,
  error,
  notifications,
  unreadCount,
  onClose,
  onMarkRead,
  onMarkAllRead,
  onActivate,
}) {
  if (!open) return null
  return (
    <section className="notification-panel" aria-label="Notifications">
      <header className="notification-panel-header">
        <div><span className="eyebrow">YOUR UPDATES</span><h2>Notifications</h2></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close notifications"><X size={17} /></button>
      </header>
      <div className="notification-panel-actions">
        <span>{unreadCount ? `${unreadCount} unread` : 'All caught up'}</span>
        <button type="button" onClick={onMarkAllRead} disabled={!unreadCount}>Mark all read</button>
      </div>
      {error && <p className="notification-error" role="alert">{error}</p>}
      {loading ? (
        <p className="notification-empty"><LoaderCircle className="loading-icon" size={16} /> Loading notifications…</p>
      ) : notifications.length ? (
        <div className="notification-items">
          {notifications.map((notification) => (
            <article className={`notification-item${notification.read_at ? '' : ' notification-unread'}`} key={notification.id}>
              <button
                type="button"
                className="notification-item-open"
                onClick={() => onActivate(notification)}
              >
                <span className="notification-item-icon"><Bell size={15} /></span>
                <span className="notification-item-copy">
                  <strong>{notification.actor_display_name || `@${notification.actor_username}`}</strong>
                  <span>{describeNotification(notification)}</span>
                  <time dateTime={notification.created_at}>{formatNotificationTime(notification.created_at)}</time>
                </span>
              </button>
              {!notification.read_at && (
                <button
                  type="button"
                  className="notification-mark-read"
                  onClick={() => onMarkRead(notification.id)}
                  aria-label="Mark notification as read"
                  title="Mark as read"
                ><Check size={15} /></button>
              )}
            </article>
          ))}
        </div>
      ) : (
        <p className="notification-empty">No notifications yet. New messages and invitations will appear here.</p>
      )}
      {notifications.length > 0 && !unreadCount && <p className="notification-read-note"><CheckCheck size={14} /> All recent notifications are read</p>}
    </section>
  )
}
