self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let notification
  try {
    notification = event.data?.json() || {}
  } catch {
    notification = { title: 'Textovert', body: 'You have a new notification.' }
  }
  const title = typeof notification.title === 'string' ? notification.title : 'Textovert'
  const options = {
    body: typeof notification.body === 'string' ? notification.body : 'You have a new notification.',
    tag: typeof notification.tag === 'string' ? notification.tag : 'textovert',
    silent: notification.silent === true,
    data: { url: typeof notification.url === 'string' ? notification.url : '/chat' },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil((async () => {
    let destination = new URL('/chat', self.location.origin)
    try {
      const requested = new URL(event.notification.data?.url || '/chat', self.location.origin)
      if (requested.origin === self.location.origin && requested.pathname === '/chat') {
        destination = requested
      }
    } catch {
      destination = new URL('/chat', self.location.origin)
    }

    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const windowClient of windows) {
      if (new URL(windowClient.url).origin !== self.location.origin) continue
      await windowClient.navigate(destination.href)
      return windowClient.focus()
    }
    return self.clients.openWindow(destination.href)
  })())
})
