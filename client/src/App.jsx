import { MotionConfig } from 'framer-motion'
import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
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

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <AuthSessionRedirect />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/chat" element={<ProtectedRoute><ChatPage /></ProtectedRoute>} />
        <Route path="*" element={<LandingPage />} />
      </Routes>
    </MotionConfig>
  )
}
