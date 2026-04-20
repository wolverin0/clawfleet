/**
 * Bearer-token authentication for theorchestra v3.0 (ADR-005).
 *
 *   1. On first boot the server generates a 256-bit token (base64url) and
 *      writes it to `vault/_auth/token.json` with 0600 perms on POSIX.
 *   2. Every HTTP + SSE + WS request must carry `Authorization: Bearer <token>`
 *      (or `?token=<token>` query string for WS upgrades that can't set
 *      headers) — else 401.
 *   3. The token can be rotated via `POST /api/auth/rotate` (requires the
 *      CURRENT token) or the `theorchestra rotate-token` CLI.
 *   4. Child PTYs inherit the current token via `THEORCHESTRA_TOKEN` env var
 *      so MCP tools spawned inside a pane hit the backend with a valid bearer.
 *
 * Three exemptions from the auth requirement:
 *   - `GET /api/health` — liveness probe; no secrets exposed.
 *   - `GET /login` + static assets — the UI has to load before the user can
 *     even see the token input.
 *   - `POST /api/auth/bootstrap` — one-shot first-install flow (see below).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AuthTokenFile {
  token: string;
  createdAt: string;
  rotatedAt?: string;
}

const TOKEN_BYTES = 32; // 256 bits

export class AuthStore {
  constructor(private readonly filePath: string) {}

  ensureDir(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  exists(): boolean {
    return fs.existsSync(this.filePath);
  }

  /** Generate and persist a fresh token. Returns the plaintext token. */
  generate(): string {
    this.ensureDir();
    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const payload: AuthTokenFile = {
      token,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf-8');
    try {
      // chmod 600 — owner-only read/write. No-op on Windows.
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      /* ignore permission errors (Windows etc) */
    }
    return token;
  }

  read(): AuthTokenFile | null {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw) as AuthTokenFile;
    } catch {
      return null;
    }
  }

  rotate(): string {
    const existing = this.read();
    const newToken = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const payload: AuthTokenFile = {
      token: newToken,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      rotatedAt: new Date().toISOString(),
    };
    this.ensureDir();
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf-8');
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      /* ignore */
    }
    return newToken;
  }

  /** Compare a candidate against the on-disk token in constant time. */
  verify(candidate: string | null): boolean {
    if (!candidate) return false;
    const stored = this.read();
    if (!stored) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(stored.token);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}

export function extractBearerFromHeader(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1]! : null;
}

export function extractTokenFromUrl(rawUrl: string): string | null {
  const q = rawUrl.indexOf('?');
  if (q === -1) return null;
  const params = new URLSearchParams(rawUrl.slice(q + 1));
  return params.get('token');
}

/**
 * Paths exempt from the auth check. Extended to include `/login`, the
 * login-time bootstrap endpoint, and static asset requests (anything that
 * contains a `.` in the last URL segment).
 */
export function isExemptFromAuth(pathname: string, method: string): boolean {
  if (method === 'OPTIONS') return true; // CORS preflight always allowed
  if (pathname === '/api/health') return true;
  if (pathname === '/login' || pathname === '/') return true;
  if (pathname === '/api/auth/status') return true;
  // Static assets — anything under /assets/ or a file name with an extension.
  if (pathname.startsWith('/assets/')) return true;
  const last = pathname.split('/').pop() ?? '';
  if (last.includes('.') && !last.startsWith('.')) return true;
  return false;
}
