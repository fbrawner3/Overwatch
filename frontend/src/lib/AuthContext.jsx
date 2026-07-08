import { AuthProvider, useAuth } from 'react-oidc-context';

const oidcConfig = {
  authority: import.meta.env.VITE_OIDC_AUTHORITY,
  client_id: import.meta.env.VITE_OIDC_CLIENT_ID,
  redirect_uri: import.meta.env.VITE_OIDC_REDIRECT_URI,
  post_logout_redirect_uri: import.meta.env.VITE_OIDC_REDIRECT_URI,
  scope: 'openid profile email',
  onSigninCallback: () => {
    window.location.replace('/');
  },
};

export const isPublic = typeof window !== 'undefined' &&
  !window.location.hostname.endsWith('.fndhome') &&
  window.location.hostname !== 'localhost' &&
  !window.location.hostname.match(/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./);

const loadingStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  height: '100vh', background: '#020617', color: '#67e8f9',
  fontFamily: 'monospace', fontSize: '13px', letterSpacing: '0.1em',
};

function AuthGate({ children }) {
  const auth = useAuth();

  if (auth.error) {
    // OIDC discovery failed (503, network error) — render without auth
    console.warn('[hexmap] OIDC init failed, running unauthenticated:', auth.error.message);
    return <>{children}</>;
  }

  if (auth.isLoading) {
    return <div style={loadingStyle}>CONNECTING TO AUTH...</div>;
  }

  if (!auth.isAuthenticated) {
    auth.signinRedirect();
    return <div style={loadingStyle}>REDIRECTING TO LOGIN...</div>;
  }

  return <>{children}</>;
}

export function AppAuthProvider({ children }) {
  if (!isPublic) return <>{children}</>;
  return (
    <AuthProvider {...oidcConfig}>
      <AuthGate>{children}</AuthGate>
    </AuthProvider>
  );
}

export { useAuth };
