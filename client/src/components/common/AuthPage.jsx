import { useState } from 'react'
import { ArrowLeft, Eye, EyeOff, LoaderCircle, LockKeyhole, Mail, UserRound } from 'lucide-react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/useAuth.js'
import { supabase } from '../../lib/supabase.js'
import Brand from './Brand.jsx'

function readableAuthError(error) {
  const message = error?.message || 'Authentication could not be completed. Please try again.'
  if (/invalid login credentials/i.test(message)) return 'Email or password is incorrect.'
  if (/email not confirmed/i.test(message)) return 'Confirm your email using the link we sent before signing in.'
  if (/user already registered/i.test(message)) return 'An account with this email already exists. Try signing in instead.'
  return message
}

export default function AuthPage({ mode }) {
  const isRegister = mode === 'register'
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [profileRecovery, setProfileRecovery] = useState(false)
  const [recoveryUsername, setRecoveryUsername] = useState('')
  const { user, profileStatus, profileError, ensureProfile } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  function showProfileRecovery(username) {
    setProfileRecovery(true)
    setRecoveryUsername(username || '')
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setSuccess('')

    if (!supabase) {
      setError('Authentication is not configured. Add the Supabase settings in client/.env and restart Vite.')
      return
    }

    const formData = new FormData(event.currentTarget)
    const email = String(formData.get('email') || '').trim().toLowerCase()
    const password = String(formData.get('password') || '')
    const username = String(formData.get('username') || '').trim().toLowerCase()
    const confirmation = String(formData.get('confirmPassword') || '')

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Enter a valid email address.')
      return
    }
    if (password.length < 8) {
      setError('Your password must be at least 8 characters long.')
      return
    }
    if (isRegister && !profileRecovery && !/^[a-z0-9_]{3,32}$/.test(username)) {
      setError('Use 3–32 characters for your username: lowercase letters, numbers, or underscores.')
      return
    }
    if (isRegister && !profileRecovery && password !== confirmation) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    try {
      if (isRegister) {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { username },
            emailRedirectTo: `${window.location.origin}/login`,
          },
        })
        if (signUpError) throw signUpError

        if (data.session && data.user) {
          try {
            await ensureProfile(data.user, username)
          } catch (profileError) {
            showProfileRecovery(username)
            throw profileError
          }
          navigate('/chat', { replace: true })
          return
        }

        setSuccess('Account created. Check your email for a confirmation link; your profile will be set up when you sign in after confirming.')
        return
      }

      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password })
      if (signInError) throw signInError
      if (!data.user) throw new Error('Supabase did not return an authenticated user.')

      try {
        await ensureProfile(data.user)
      } catch (profileError) {
        showProfileRecovery(data.user.user_metadata?.username || '')
        throw profileError
      }
      navigate(location.state?.from?.pathname || '/chat', { replace: true })
    } catch (submitError) {
      setError(readableAuthError(submitError))
    } finally {
      setLoading(false)
    }
  }

  async function handleProfileRecovery(event) {
    event.preventDefault()
    setError('')
    setSuccess('')
    const username = (recoveryUsername || user?.user_metadata?.username || '').trim().toLowerCase()
    if (!/^[a-z0-9_]{3,32}$/.test(username)) {
      setError('Use 3–32 characters for your username: lowercase letters, numbers, or underscores.')
      return
    }
    setLoading(true)
    try {
      const { data, error: updateError } = await supabase.auth.updateUser({ data: { username } })
      if (updateError) throw updateError
      if (!data.user) throw new Error('Supabase did not return your updated account.')
      await ensureProfile(data.user, username)
      navigate(location.state?.from?.pathname || '/chat', { replace: true })
    } catch (profileError) {
      setError(readableAuthError(profileError))
    } finally {
      setLoading(false)
    }
  }

  const handleForgotPassword = () => {
    setError('Password reset is not available yet. Contact the project administrator for help.')
  }
  const showingProfileRecovery = profileRecovery || Boolean(user && profileStatus === 'error')
  const visibleError = error || (user && profileStatus === 'error' ? profileError : '')

  return (
    <main className="auth-page">
      <header className="auth-topbar">
        <Brand />
        <Link className="back-link" to="/"><ArrowLeft size={16} /> Back to home</Link>
      </header>
      <section className="auth-card">
        <div className="auth-heading">
          <span className="eyebrow">{showingProfileRecovery ? 'One last step' : isRegister ? 'A little more connected' : 'Welcome back'}</span>
          <h1>{showingProfileRecovery ? 'Choose your username.' : isRegister ? 'Create your space.' : 'Good to see you.'}</h1>
          <p>{showingProfileRecovery ? 'Your account is signed in. Choose an available username to finish profile setup.' : isRegister ? 'A quieter place for the conversations that matter.' : 'Pick up where your conversations left off.'}</p>
        </div>
        <form className="auth-form" onSubmit={showingProfileRecovery ? handleProfileRecovery : handleSubmit}>
          {showingProfileRecovery ? (
            <label className="field">
              <span>Username</span>
              <span className="input-wrap"><UserRound size={17} /><input name="recoveryUsername" autoComplete="username" placeholder="3–32 letters, numbers, or underscores" minLength={3} maxLength={32} value={recoveryUsername || user?.user_metadata?.username || ''} onChange={(event) => setRecoveryUsername(event.target.value)} required /></span>
            </label>
          ) : (
            <>
              {isRegister && (
                <label className="field">
                  <span>Username</span>
                  <span className="input-wrap"><UserRound size={17} /><input name="username" autoComplete="username" placeholder="How should we call you?" minLength={3} maxLength={32} pattern="[a-zA-Z0-9_]{3,32}" title="Use 3–32 letters, numbers, or underscores." required /></span>
                </label>
              )}
              <label className="field">
                <span>Email address</span>
                <span className="input-wrap"><Mail size={17} /><input name="email" type="email" autoComplete="email" placeholder="you@example.com" required /></span>
              </label>
              <label className="field">
                <span>Password</span>
                <span className="input-wrap">
                  <LockKeyhole size={17} />
                  <input name="password" type={showPassword ? 'text' : 'password'} autoComplete={isRegister ? 'new-password' : 'current-password'} placeholder="At least 8 characters" minLength={8} required />
                  <button className="visibility-button" type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button>
                </span>
              </label>
              {isRegister ? (
                <label className="field">
                  <span>Confirm password</span>
                  <span className="input-wrap">
                    <LockKeyhole size={17} />
                    <input name="confirmPassword" type={showConfirmation ? 'text' : 'password'} autoComplete="new-password" placeholder="Enter your password again" minLength={8} required />
                    <button className="visibility-button" type="button" onClick={() => setShowConfirmation((visible) => !visible)} aria-label={showConfirmation ? 'Hide confirmation password' : 'Show confirmation password'}>{showConfirmation ? <EyeOff size={17} /> : <Eye size={17} />}</button>
                  </span>
                </label>
              ) : (
                <div className="forgot-row"><span>Keep your account secure</span><button type="button" className="text-button" onClick={handleForgotPassword}>Forgot password?</button></div>
              )}
            </>
          )}
          {visibleError && <p className="form-notice" role="alert">{visibleError}</p>}
          {success && <p className="form-notice form-notice-success" role="status">{success}</p>}
          <button className="button button-primary auth-submit" type="submit" disabled={loading}>
            {loading && <LoaderCircle className="loading-icon" size={16} />}
            {loading ? (showingProfileRecovery ? 'Setting up profile…' : isRegister ? 'Creating account…' : 'Signing in…') : showingProfileRecovery ? 'Save username and continue' : isRegister ? 'Create account' : 'Sign in'}
            {!loading && <span aria-hidden="true">→</span>}
          </button>
          {!showingProfileRecovery && <p className="auth-legal">{isRegister ? 'By continuing, you agree to use Textovert thoughtfully.' : 'Your conversations are yours. We keep it that way.'}</p>}
        </form>
        {!showingProfileRecovery && (
          <div className="auth-switch">
            {isRegister ? 'Already have an account?' : 'New to Textovert?'}{' '}
            <Link to={isRegister ? '/login' : '/register'}>{isRegister ? 'Sign in' : 'Create an account'}</Link>
          </div>
        )}
      </section>
      <p className="auth-footer">A thoughtful space for staying close.</p>
    </main>
  )
}
