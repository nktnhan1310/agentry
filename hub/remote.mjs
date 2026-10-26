// Phone access: the control panel on a private remote host (e.g. `tailscale serve`) behind per-device login.
// The daemon still listens on 127.0.0.1; the proxy forwards to it. Local = localhost Host and no proxy headers.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { loadConfig, loadState, saveConfig, saveState } from './store.mjs';

export const COOKIE = 'kit_device';
const PAIR_MIN = 10;
const PAIR_TRIES = 5;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L: easy to type on a phone
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'tailscale-user-login'];
const SEEN_EVERY_MS = 3600_000;

const sha = (s) => createHash('sha256').update(String(s)).digest();
const hostOnly = (h = '') => h.toLowerCase().replace(/:\d+$/, '');
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export class AuthError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

export function isLocal(req, port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host) && !PROXY_HEADERS.some((h) => req.headers[h]);
}

// DNS-rebinding guard: localhost, or a host listed in ui.remoteHosts.
export function hostAllowed(req, cfg) {
  const port = cfg.ui.port;
  if ([`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return true;
  return (cfg.ui.remoteHosts || []).map(hostOnly).includes(hostOnly(req.headers.host));
}

function cookie(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return '';
}

// The paired device behind this request, or null. Refreshes lastSeenAt at most hourly.
export function deviceFor(req) {
  const token = cookie(req);
  if (!token) return null;
  const h = sha(token);
  const cfg = loadConfig();
  const d = (cfg.devices || []).find((x) => timingSafeEqual(Buffer.from(x.hash, 'hex'), h));
  if (!d) return null;
  if (Date.now() - Date.parse(d.lastSeenAt || 0) > SEEN_EVERY_MS) { d.lastSeenAt = new Date().toISOString(); saveConfig(cfg); }
  return d;
}

// One active code at a time, stored hashed in state.json so the CLI and the UI share it.
export function newPairCode() {
  const raw = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  const s = loadState();
  s.pair = { hash: sha(raw).toString('hex'), expires: Date.now() + PAIR_MIN * 60_000, tries: 0 };
  saveState(s);
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresMin: PAIR_MIN };
}

// Exchange a pairing code for a device token (returned once; only its hash is stored).
export function pair(code, name) {
  const s = loadState();
  const p = s.pair;
  if (!p || Date.now() > p.expires) { delete s.pair; saveState(s); throw new AuthError(400, 'no pairing code is active: create one on the PC (Settings → Phone access, or `kit hub phone pair`)'); }
  if (!timingSafeEqual(Buffer.from(p.hash, 'hex'), sha(normCode(code)))) {
    p.tries += 1;
    if (p.tries >= PAIR_TRIES) delete s.pair;
    saveState(s);
    throw new AuthError(400, p.tries >= PAIR_TRIES ? 'too many wrong codes: create a new one on the PC' : 'wrong code');
  }
  delete s.pair;
  saveState(s);
  const token = randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  const cfg = loadConfig();
  const device = { id: randomBytes(4).toString('hex'), name: String(name || 'phone').trim().slice(0, 40) || 'phone', hash: sha(token).toString('hex'), createdAt: now, lastSeenAt: now };
  cfg.devices = [...(cfg.devices || []), device];
  saveConfig(cfg);
  return { token, device: publicDevice(device) };
}

export const publicDevice = ({ hash, ...d }) => d;
export const listDevices = () => (loadConfig().devices || []).map(publicDevice);

export function revoke(id) {
  const cfg = loadConfig();
  const before = (cfg.devices || []).length;
  cfg.devices = (cfg.devices || []).filter((d) => d.id !== id);
  if (cfg.devices.length === before) throw new AuthError(404, `no device ${id}`);
  saveConfig(cfg);
  return { ok: true };
}

// ~400 days is the longest cookie lifetime browsers keep.
export const deviceCookie = (token, secure) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=34560000${secure ? '; Secure' : ''}`;
