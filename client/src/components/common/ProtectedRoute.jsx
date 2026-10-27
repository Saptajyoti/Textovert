import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/useAuth.js'

export default function ProtectedRoute({ children }) {
  const { user, authLoading, profileStatus } = useAuth()
  const location = useLocation()

  if (authLoading || (user && profileStatus === 'loading')) {
    return <main className="auth-loading" role="status">Checking your account…</main>
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />
  if (profileStatus === 'error') {
    return <Navigate to="/login" replace state={{ from: location, profileSetupRequired: true }} />
  }
  return children
}
