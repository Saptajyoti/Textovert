import { MotionConfig } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Download, WifiOff, X } from 'lucide-react'
import { useAuth } from './contexts/useAuth.js'
import ProtectedRoute from './components/common/ProtectedRoute.jsx'
import LandingPage from './pages/LandingPage.jsx'
import LoginPage from './pages/LoginPage.jsx'
import RegisterPage from './pages/RegisterPage.jsx'
import ChatPage from './pages/ChatPage.jsx'

function AuthSessionRedirect() {
  const { user, authLoading, profileStatus } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    if (!authLoading && user && profileStatus === 'ready' && ['/', '/login', '/register'].includes(location.pathname)) {
      navigate('/chat', { replace: true })
    }
  }, [user, authLoading, profileStatus, location.pathname, navigate])

  return null
}

function PwaControls() {
  const [online, setOnline] = useState(() => navigator.onLine)
  const [installPrompt, setInstallPrompt] = useState(null)
  const [installError, setInstallError] = useState('')
  const installPromptRef = useRef(null)

  useEffect(() => {
    function updateOnlineStatus() {
      setOnline(navigator.onLine)
    }

    window.addEventListener('online', updateOnlineStatus)
    window.addEventListener('offline', updateOnlineStatus)
    return () => {
      window.removeEventListener('online', updateOnlineStatus)
      window.removeEventListener('offline', updateOnlineStatus)
    }
  }, [])

  useEffect(() => {
    function handleInstallPrompt(event) {
      event.preventDefault()
      installPromptRef.current = event
      setInstallPrompt(event)
      setInstallError('')
    }

    function handleInstalled() {
      installPromptRef.current = null
      setInstallPrompt(null)
      setInstallError('')
    }

    window.addEventListener('beforeinstallprompt', handleInstallPrompt)
    window.addEventListener('appinstalled', handleInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', handleInstallPrompt)
      window.removeEventListener('appinstalled', handleInstalled)
    }
  }, [])

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return undefined

    let disposed = false
    let updateInterval
    let visibilityHandler
    const checkForUpdates = (registration) => {
      registration.update().catch((error) => {
        console.error('Textovert could not check for a service-worker update.', error)
      })
    }

    navigator.serviceWorker.register('/service-worker.js', { updateViaCache: 'none' })
      .then((registration) => {
        if (disposed) return
        checkForUpdates(registration)
        updateInterval = window.setInterval(() => checkForUpdates(registration), 60 * 60 * 1000)
        visibilityHandler = () => {
          if (document.visibilityState === 'visible') checkForUpdates(registration)
        }
        document.addEventListener('visibilitychange', visibilityHandler)
      })
      .catch((error) => {
        console.error('Textovert could not register its service worker.', error)
      })

    return () => {
      disposed = true
      window.clearInterval(updateInterval)
      if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler)
    }
  }, [])

  async function installApp() {
    const prompt = installPromptRef.current
    if (!prompt) return

    try {
      await prompt.prompt()
      await prompt.userChoice
      installPromptRef.current = null
      setInstallPrompt(null)
      setInstallError('')
    } catch (error) {
      setInstallError('Installation could not be started. Try your browser’s install option instead.')
      console.error('Textovert installation prompt failed.', error)
    }
  }

  return (
    <>
      {!online && (
        <div className="network-banner" role="status" aria-live="polite">
          <WifiOff size={16} aria-hidden="true" />
          <span>You’re offline. Messages and uploads need a connection.</span>
        </div>
      )}
      {installPrompt && (
        <aside className="install-prompt" aria-label="Install Textovert">
          <span><Download size={17} aria-hidden="true" /><strong>Keep Textovert close</strong></span>
          <button type="button" className="button button-primary button-small" onClick={installApp}>Install</button>
          <button
            type="button"
            className="icon-button install-dismiss"
            onClick={() => {
              installPromptRef.current = null
              setInstallPrompt(null)
            }}
            aria-label="Dismiss install prompt"
          ><X size={17} /></button>
          {installError && <p role="status">{installError}</p>}
        </aside>
      )}
    </>
  )
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <div className="app-shell">
        <PwaControls />
        <AuthSessionRedirect />
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/chat" element={<ProtectedRoute><ChatPage /></ProtectedRoute>} />
          <Route path="*" element={<LandingPage />} />
        </Routes>
      </div>
    </MotionConfig>
  )
}
