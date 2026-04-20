import { useState } from 'react';
import { setToken } from './auth';

interface LoginProps {
  onAuthenticated: () => void;
}

export function Login({ onAuthenticated }: LoginProps) {
  const [token, setTokenInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = token.trim();
    if (!value) {
      setError('Paste the token from the backend console.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/sessions', {
        headers: { Authorization: `Bearer ${value}` },
      });
      if (!res.ok) {
        setError(`Backend rejected the token (HTTP ${res.status}). Check the value.`);
        setSubmitting(false);
        return;
      }
      setToken(value);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1 className="login-title">theorchestra</h1>
        <p className="login-hint">
          Paste the auth token printed by <code>theorchestra start</code>. You can find it at
          <code> vault/_auth/token.json</code> on the server.
        </p>
        <input
          type="password"
          className="login-input"
          value={token}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="paste token here"
          autoFocus
          spellCheck={false}
        />
        {error && <div className="login-error">{error}</div>}
        <button type="submit" className="login-submit" disabled={submitting}>
          {submitting ? 'Verifying...' : 'Continue'}
        </button>
      </form>
    </div>
  );
}
