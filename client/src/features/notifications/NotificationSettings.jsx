import { Bell, X } from 'lucide-react'

const preferences = [
  ['in_app_enabled', 'In-app notifications', 'Show notification history and unread badges.'],
  ['messages_enabled', 'Incoming messages', 'Notify me when someone sends a message.'],
  ['invitations_enabled', 'Conversation invitations', 'Notify me about invitations and acceptances.'],
  ['sound_enabled', 'Notification sound', 'Play a brief sound for incoming activity.'],
  ['preview_enabled', 'Message previews', 'Allow opted-in browser notifications to show message text.'],
  ['while_open_enabled', 'Notify while conversation is open', 'Allow browser notifications while the related conversation is visible.'],
]

export default function NotificationSettings({
  open,
  values,
  loading,
  error,
  browserSupported,
  pushConfigured,
  browserPermission,
  onChange,
  onEnableBrowser,
  onDisableBrowser,
  onClose,
}) {
  if (!open) return null
  return (
    <div className="notification-settings-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="notification-settings" role="dialog" aria-modal="true" aria-labelledby="notification-settings-title">
        <header className="notification-settings-header">
          <div><span className="eyebrow">PREFERENCES</span><h2 id="notification-settings-title">Notifications</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close notification settings"><X size={17} /></button>
        </header>
        <p className="notification-settings-intro">Choose what Textovert can notify you about. Browser permission is controlled separately by your browser.</p>
        {error && <p className="notification-error" role="alert">{error}</p>}
        <div className="notification-preference-list">
          {preferences.map(([key, title, description]) => (
            <label className="notification-preference" key={key}>
              <span><strong>{title}</strong><small>{description}</small></span>
              <input type="checkbox" checked={Boolean(values[key])} onChange={(event) => onChange(key, event.target.checked)} disabled={loading} />
            </label>
          ))}
          <div className="browser-notification-setting">
            <div className="browser-notification-copy">
              <strong>Browser notifications</strong>
              <small>
                {!browserSupported
                  ? 'This browser does not support service-worker notifications.'
                  : !pushConfigured
                    ? 'Web Push has not been configured on the server.'
                    : `Browser permission: ${browserPermission}.`}
              </small>
            </div>
            <button
              type="button"
              className={values.browser_enabled ? 'button button-secondary' : 'button button-primary'}
              onClick={values.browser_enabled ? onDisableBrowser : onEnableBrowser}
              disabled={loading || !browserSupported || !pushConfigured || browserPermission === 'denied' && !values.browser_enabled}
            >
              <Bell size={15} /> {values.browser_enabled ? 'Disable' : 'Enable'}
            </button>
          </div>
          {browserPermission === 'denied' && <p className="browser-permission-note">Notifications are blocked in browser settings. Textovert will not prompt again.</p>}
        </div>
      </section>
    </div>
  )
}
