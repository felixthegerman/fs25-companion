const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

const PORT = Number(process.env.PORT || 3000);
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const ADMIN_DISCORD_ID = process.env.ADMIN_DISCORD_ID || '1124793204588433518';
const SESSION_SECRET = process.env.SESSION_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const DISCORD_API = 'https://discord.com/api/v10';
const REDIRECT_URI = `${APP_URL}/api/auth/callback`;
const SESSION_TTL = 60 * 60 * 24 * 7;
const STATE_TTL = 10 * 60;

for (const [name, value] of Object.entries({ DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, SESSION_SECRET, SUPABASE_URL, SUPABASE_SECRET_KEY })) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signSession(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

function makeSession(discordId) {
  const body = base64url(JSON.stringify({ sub: discordId, exp: Math.floor(Date.now() / 1000) + SESSION_TTL }));
  return `${body}.${signSession(body)}`;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) { try { return decodeURIComponent(rest.join('=')); } catch { return null; } }
  }
  return null;
}

function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  const expected = signSession(body);
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.sub || !/^\d{17,20}$/.test(String(data.sub))) return null;
    if (!Number.isFinite(data.exp) || data.exp < Math.floor(Date.now() / 1000)) return null;
    return { sub: String(data.sub), exp: data.exp };
  } catch {
    return null;
  }
}

function cookieOptions(maxAge, secure) {
  return `Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function setCookie(res, name, value, maxAge, secure) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; ${cookieOptions(maxAge, secure)}`);
}

function clearCookie(res, name, secure) {
  res.append('Set-Cookie', `${name}=; ${cookieOptions(0, secure)}`);
}

function isSecureRequest() {
  return APP_URL.startsWith('https://');
}

function randomState() {
  return crypto.randomBytes(32).toString('hex');
}

function avatarUrl(discordId, avatarHash) {
  if (avatarHash) return `https://cdn.discordapp.com/avatars/${discordId}/${avatarHash}.png?size=128`;
  const index = Number((BigInt(discordId) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

async function getUserById(discordId) {
  const { data, error } = await supabase
    .from('discord_users')
    .select('discord_id, username, global_name, avatar_hash, status, is_admin, created_at, updated_at')
    .eq('discord_id', discordId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function requireUser(req, res, next) {
  try {
    const session = verifySession(readCookie(req, 'fs25_session'));
    if (!session) return res.status(401).json({ error: 'unauthenticated' });
    const user = await getUserById(session.sub);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    req.session = session;
    req.user = user;
    next();
  } catch (error) {
    console.error('requireUser:', error.message);
    res.status(500).json({ error: 'server_error' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.discord_id !== ADMIN_DISCORD_ID || !req.user?.is_admin) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.use('/assets', express.static(path.join(__dirname, 'assets'), { fallthrough: true }));

app.get('/api/auth/login', (_req, res) => {
  const state = randomState();
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'identify',
    state
  });
  setCookie(res, 'oauth_state', state, STATE_TTL, isSecureRequest());
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get('/api/auth/callback', async (req, res) => {
  const stateCookie = readCookie(req, 'oauth_state');
  const state = String(req.query.state || '');
  clearCookie(res, 'oauth_state', isSecureRequest());

  if (!stateCookie || !state || stateCookie !== state) {
    return res.status(400).send('Invalid OAuth state. Please start the Discord login again.');
  }
  if (req.query.error) {
    return res.redirect(`${APP_URL}/?auth=denied`);
  }

  try {
    const code = String(req.query.code || '');
    if (!code) return res.status(400).send('Missing OAuth code.');

    const basicAuth = Buffer.from(`${DISCORD_CLIENT_ID}:${DISCORD_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      })
    });
    if (!tokenRes.ok) throw new Error(`Discord token exchange failed: ${tokenRes.status}`);
    const token = await tokenRes.json();

    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    if (!userRes.ok) throw new Error(`Discord user lookup failed: ${userRes.status}`);
    const discordUser = await userRes.json();

    const discordId = String(discordUser.id);
    const existing = await getUserById(discordId);
    const isAdmin = discordId === ADMIN_DISCORD_ID;
    const nextStatus = isAdmin ? 'approved' : (existing?.status || 'pending');

    const { error: upsertError } = await supabase.from('discord_users').upsert({
      discord_id: discordId,
      username: discordUser.username,
      global_name: discordUser.global_name || null,
      avatar_hash: discordUser.avatar || null,
      status: nextStatus,
      is_admin: isAdmin,
      updated_at: new Date().toISOString()
    }, { onConflict: 'discord_id' });
    if (upsertError) throw upsertError;

    setCookie(res, 'fs25_session', makeSession(discordId), SESSION_TTL, isSecureRequest());
    res.redirect(APP_URL);
  } catch (error) {
    console.error('OAuth callback:', error);
    res.status(500).send('Discord login failed. Check the server logs and configuration.');
  }
});

app.get('/api/me', async (req, res) => {
  try {
    const session = verifySession(readCookie(req, 'fs25_session'));
    if (!session) return res.json({ authenticated: false });
    const user = await getUserById(session.sub);
    if (!user) return res.json({ authenticated: false });
    res.json({ authenticated: true, user: {
      discord_id: user.discord_id,
      username: user.username,
      display_name: user.global_name || user.username,
      avatar_url: avatarUrl(user.discord_id, user.avatar_hash),
      status: user.status,
      is_admin: user.discord_id === ADMIN_DISCORD_ID && Boolean(user.is_admin)
    }});
  } catch (error) {
    console.error('/api/me:', error.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearCookie(res, 'fs25_session', isSecureRequest());
  res.json({ ok: true });
});

app.get('/api/admin/users', requireUser, requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('discord_users')
      .select('discord_id, username, global_name, avatar_hash, status, is_admin, created_at, updated_at')
      .order('status', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ users: (data || []).map(u => ({
      ...u,
      avatar_url: avatarUrl(u.discord_id, u.avatar_hash),
      display_name: u.global_name || u.username
    })) });
  } catch (error) {
    console.error('/api/admin/users:', error.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.patch('/api/admin/users/:discordId', requireUser, requireAdmin, async (req, res) => {
  const discordId = String(req.params.discordId || '');
  const status = String(req.body?.status || '');
  if (!/^\d{17,20}$/.test(discordId) || !['pending', 'approved', 'blocked'].includes(status)) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  if (discordId === ADMIN_DISCORD_ID) {
    return res.status(400).json({ error: 'admin_cannot_be_modified' });
  }
  try {
    const { error } = await supabase.from('discord_users')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('discord_id', discordId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    console.error('/api/admin/users/:discordId:', error.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`FS25 Companion listening on ${APP_URL}`);
  console.log(`Discord OAuth redirect: ${REDIRECT_URI}`);
});
