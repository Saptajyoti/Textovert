import { supabase } from './supabase.js'

const configuredApiUrl = import.meta.env.VITE_API_URL?.trim()
const apiBaseUrl = configuredApiUrl || (import.meta.env.DEV ? 'http://localhost:5000' : '')

if (!apiBaseUrl) {
  throw new Error('VITE_API_URL must be set to the deployed Textovert API URL.')
}

let parsedApiUrl
try {
  parsedApiUrl = new URL(apiBaseUrl)
} catch {
  throw new Error('VITE_API_URL must be a valid absolute URL.')
}

if (!['http:', 'https:'].includes(parsedApiUrl.protocol)) {
  throw new Error('VITE_API_URL must use HTTP or HTTPS.')
}
if (import.meta.env.PROD && parsedApiUrl.protocol !== 'https:') {
  throw new Error('VITE_API_URL must use HTTPS in production.')
}

const normalizedApiUrl = parsedApiUrl.toString().replace(/\/+$/, '')

export async function getAccessToken() {
  if (!supabase) throw new Error('Supabase is not configured.')
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  if (!data.session?.access_token) throw new Error('Your session has expired. Sign in again to continue.')
  return data.session.access_token
}

async function fetchWithDiagnostics(request, options) {
  try {
    return await request()
  } catch (error) {
    console.warn('[api] Request failed before receiving a response.', {
      method: options.method || 'GET',
      apiHost: parsedApiUrl.host,
      errorType: error instanceof Error ? error.name : 'UnknownError',
    })
    throw error
  }
}

export async function messagingRequest(path, options = {}) {
  const accessToken = await getAccessToken()
  const response = await fetchWithDiagnostics(() => fetch(`${normalizedApiUrl}/api${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  }), options)
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'The messaging request could not be completed.')
  return result
}

export function getSocketUrl() {
  return normalizedApiUrl
}
