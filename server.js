require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const requiredEnvironmentVariables = [
    'DISCORD_CLIENT_ID',
    'DISCORD_CLIENT_SECRET',
    'ADMIN_DISCORD_ID',
    'SESSION_SECRET',
    'SUPABASE_URL',
    'SUPABASE_SECRET_KEY',
];

const missingEnvironmentVariables = requiredEnvironmentVariables.filter((name) => !process.env[name]);
if (missingEnvironmentVariables.length > 0) {
    console.error(`Fehlende Umgebungsvariablen: ${missingEnvironmentVariables.join(', ')}`);
    process.exit(1);
}

const appUrl = process.env.APP_URL?.replace(/\/+$/, '');
const discordRedirectUri = process.env.DISCORD_REDIRECT_URI || (appUrl
    ? `${appUrl}/api/auth/callback`
    : undefined);

if (!discordRedirectUri) {
    console.error('DISCORD_REDIRECT_URI oder APP_URL muss gesetzt sein.');
    process.exit(1);
}

try {
    new URL(discordRedirectUri);
} catch {
    console.error('DISCORD_REDIRECT_URI ist keine gültige URL.');
    process.exit(1);
}

const app = express();
const isProduction = process.env.NODE_ENV === 'production' || discordRedirectUri.startsWith('https://');
const ADMIN_DISCORD_ID = '1124793204588433518';
if (String(process.env.ADMIN_DISCORD_ID).trim() !== ADMIN_DISCORD_ID) {
    console.warn(`[config] ADMIN_DISCORD_ID wird ignoriert; der feste Hauptadmin ist ${ADMIN_DISCORD_ID}.`);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});

class SupabaseSessionStore extends session.Store {
    constructor(client) {
        super();
        this.client = client;
        this.fallback = new session.MemoryStore();
        this.warned = false;
    }

    warn(error) {
        if (this.warned) return;
        this.warned = true;
        console.warn('[session-store] Supabase-Sitzungen nicht verfügbar, temporärer Speicher wird verwendet:', error?.message);
    }

    get(sid, callback) {
        this.client.from('website_sessions').select('sess').eq('id', sid).gt('expires_at', new Date().toISOString()).maybeSingle()
            .then(({ data, error }) => {
                if (error) {
                    this.warn(error);
                    return this.fallback.get(sid, callback);
                }
                callback(null, data?.sess || null);
            }).catch((error) => {
                this.warn(error);
                this.fallback.get(sid, callback);
            });
    }

    set(sid, value, callback = () => {}) {
        const expiresAt = value.cookie?.expires
            ? new Date(value.cookie.expires).toISOString()
            : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        this.fallback.set(sid, value, () => {});
        this.client.from('website_sessions').upsert({ id: sid, sess: value, expires_at: expiresAt, updated_at: new Date().toISOString() })
            .then(({ error }) => {
                if (error) this.warn(error);
                callback(null);
            }).catch((error) => {
                this.warn(error);
                callback(null);
            });
    }

    destroy(sid, callback = () => {}) {
        this.fallback.destroy(sid, () => {});
        this.client.from('website_sessions').delete().eq('id', sid)
            .then(({ error }) => callback(error || null))
            .catch((error) => callback(error));
    }

    touch(sid, value, callback = () => {}) {
        this.set(sid, value, callback);
    }
}

const sessionStore = new SupabaseSessionStore(supabase);

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(session({
    name: 'fs25.sid',
    store: sessionStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
    },
}));

function avatarUrl(discordUser) {
    if (!discordUser.avatar) {
        const index = Number((BigInt(discordUser.id) >> 22n) % 6n);
        return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
    }

    const extension = discordUser.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.${extension}`;
}

function sessionUser(databaseUser) {
    const isSuperAdmin = String(databaseUser.discord_id) === ADMIN_DISCORD_ID;
    const schemaReady = Object.prototype.hasOwnProperty.call(databaseUser, 'can_manage_users');
    return {
        id: databaseUser.discord_id,
        username: databaseUser.global_name || databaseUser.username,
        avatar: databaseUser.avatar_url,
        status: isSuperAdmin ? 'approved' : databaseUser.status,
        is_approved: isSuperAdmin || databaseUser.status === 'approved',
        is_admin: isSuperAdmin || databaseUser.is_admin,
        is_super_admin: isSuperAdmin,
        schema_ready: schemaReady,
        permissions: {
            can_create_tasks: isSuperAdmin || Boolean(databaseUser.can_create_tasks),
            can_delete_tasks: isSuperAdmin || Boolean(databaseUser.can_delete_tasks),
            can_manage_users: isSuperAdmin || Boolean(databaseUser.can_manage_users),
        },
    };
}

function avatarUrlFromRecord(user) {
    return avatarUrl({ id: user.discord_id, avatar: user.avatar_hash });
}

function requireApprovedPermission(permission) {
    return async (req, res, next) => {
        if (!req.session.user?.id) return res.status(401).json({ error: 'Nicht angemeldet.' });

        try {
            const { data: databaseUser, error } = await supabase
                .from('discord_users')
                .select('*')
                .eq('discord_id', req.session.user.id)
                .single();

            if (error || !databaseUser) throw error || new Error('Benutzer nicht gefunden.');
            req.session.user = sessionUser({ ...databaseUser, avatar_url: req.session.user.avatar });

            if (!req.session.user.is_approved) {
                return res.status(403).json({ error: 'Der Benutzer ist nicht freigeschaltet.' });
            }
            if (permission && !req.session.user.permissions[permission]) {
                return res.status(403).json({ error: 'Dafür fehlt die Berechtigung.' });
            }

            req.databaseUser = databaseUser;
            next();
        } catch (error) {
            console.error('[authorization] Berechtigungen konnten nicht geprüft werden:', error?.message);
            res.status(503).json({ error: 'Berechtigungen konnten nicht geprüft werden.' });
        }
    };
}

const realtimeClients = new Set();
function broadcast(event, data = {}) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of realtimeClients) {
        try { client.write(message); } catch { realtimeClients.delete(client); }
    }
}

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function redirectWithError(res, error) {
    res.redirect(`/?error=${encodeURIComponent(error)}`);
}

app.get('/api/auth/login', (req, res) => {
    const state = crypto.randomBytes(32).toString('base64url');
    req.session.oauthState = state;

    const authorizeUrl = new URL('https://discord.com/oauth2/authorize');
    authorizeUrl.search = new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        redirect_uri: discordRedirectUri,
        response_type: 'code',
        scope: 'identify',
        state,
        prompt: 'consent',
    }).toString();

    req.session.save((error) => {
        if (error) {
            console.error('[auth/login] Session konnte nicht gespeichert werden:', error.message);
            return redirectWithError(res, 'session_failed');
        }
        res.redirect(authorizeUrl.toString());
    });
});

app.get('/api/auth/callback', async (req, res) => {
    const { code, state, error: discordError } = req.query;
    const expectedState = req.session.oauthState;
    delete req.session.oauthState;

    if (discordError) return redirectWithError(res, 'discord_denied');
    if (!code) return redirectWithError(res, 'no_code');
    if (!state || !expectedState || state !== expectedState) {
        return redirectWithError(res, 'invalid_state');
    }

    try {
        const tokenResponse = await axios.post(
            'https://discord.com/api/oauth2/token',
            new URLSearchParams({
                client_id: process.env.DISCORD_CLIENT_ID,
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: String(code),
                redirect_uri: discordRedirectUri,
            }),
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 10000,
            },
        );

        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` },
            timeout: 10000,
        });

        const discordUser = userResponse.data;
        const isAdmin = discordUser.id === ADMIN_DISCORD_ID;

        const { data: existingUser, error: selectError } = await supabase
            .from('discord_users')
            .select('*')
            .eq('discord_id', discordUser.id)
            .maybeSingle();

        if (selectError) throw selectError;

        const userRecord = {
            discord_id: discordUser.id,
            username: discordUser.username,
            global_name: discordUser.global_name || null,
            avatar_hash: discordUser.avatar || null,
            status: isAdmin ? 'approved' : (existingUser?.status || 'pending'),
            is_admin: isAdmin,
            can_create_tasks: isAdmin || Boolean(existingUser?.can_create_tasks),
            can_delete_tasks: isAdmin || Boolean(existingUser?.can_delete_tasks),
            can_manage_users: isAdmin || Boolean(existingUser?.can_manage_users),
            last_seen_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };

        let { data: savedUser, error: upsertError } = await supabase
            .from('discord_users')
            .upsert(userRecord, { onConflict: 'discord_id' })
            .select('*')
            .single();

        // Keep the Discord login operational while an older installation is
        // waiting for the admin-permissions migration to be applied.
        if (upsertError?.code === '42703' || upsertError?.code === 'PGRST204') {
            const legacyRecord = {
                discord_id: userRecord.discord_id,
                username: userRecord.username,
                global_name: userRecord.global_name,
                avatar_hash: userRecord.avatar_hash,
                status: userRecord.status,
                is_admin: userRecord.is_admin,
                updated_at: userRecord.updated_at,
            };
            const legacyResult = await supabase
                .from('discord_users')
                .upsert(legacyRecord, { onConflict: 'discord_id' })
                .select('*')
                .single();
            savedUser = legacyResult.data;
            upsertError = legacyResult.error;
            console.warn('[auth/callback] Admin-Migration fehlt; Legacy-Login wird verwendet.');
        }

        if (upsertError) throw upsertError;

        req.session.user = sessionUser({
            ...savedUser,
            avatar_url: avatarUrl(discordUser),
        });

        req.session.save((saveError) => {
            if (saveError) {
                console.error('[auth/callback] Session konnte nicht gespeichert werden:', saveError.message);
                return redirectWithError(res, 'session_failed');
            }
            res.redirect('/');
        });
    } catch (error) {
        const details = error.response?.data || error.message;
        console.error('[auth/callback] Anmeldung fehlgeschlagen:', details);
        redirectWithError(res, 'auth_failed');
    }
});

app.get('/api/auth/me', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.session.user) return res.json({ loggedIn: false });

    try {
        const { data: databaseUser, error } = await supabase
            .from('discord_users')
            .select('*')
            .eq('discord_id', req.session.user.id)
            .single();

        if (error) throw error;

        req.session.user = sessionUser({
            ...databaseUser,
            avatar_url: req.session.user.avatar,
        });
        res.json({ loggedIn: true, user: req.session.user });
    } catch (error) {
        console.error('[auth/me] Benutzerstatus konnte nicht geladen werden:', error.message);
        res.status(503).json({ loggedIn: false, error: 'database_unavailable' });
    }
});

app.get('/api/events', requireApprovedPermission(), (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(`event: connected\ndata: {"ok":true}\n\n`);
    realtimeClients.add(res);

    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25000);
    req.on('close', () => {
        clearInterval(keepAlive);
        realtimeClients.delete(res);
    });
});

app.post('/api/admin/telemetry/pairing-code', requireApprovedPermission('can_manage_users'), async (req, res) => {
    const code = String(crypto.randomInt(10000000, 100000000));
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const { data, error } = await supabase.from('telemetry_sources').insert({
        source_name: String(req.body?.name || 'FS25 Spielstand').slice(0, 80),
        pairing_code_hash: sha256(code), pairing_expires_at: expiresAt,
    }).select('id').single();
    if (error) return res.status(500).json({ error: 'Kopplungscode konnte nicht erstellt werden.' });
    res.json({ code, expires_at: expiresAt, source_id: data.id });
});

app.get('/api/telemetry/status', requireApprovedPermission(), async (req, res) => {
    const { data, error } = await supabase.from('telemetry_sources')
        .select('id,source_name,paired_at,last_seen_at').not('paired_at', 'is', null)
        .order('last_seen_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
    if (error) return res.status(500).json({ error: 'Telemetriestatus konnte nicht geladen werden.' });
    res.json({ source: data || null, connected: Boolean(data?.last_seen_at && Date.now() - new Date(data.last_seen_at).getTime() < 90000) });
});

app.post('/api/telemetry/pair', async (req, res) => {
    const code = String(req.body?.code || '').trim();
    if (!/^\d{8}$/.test(code)) return res.status(400).json({ error: 'Ungültiger Kopplungscode.' });
    const { data: source, error } = await supabase.from('telemetry_sources').select('id,pairing_expires_at')
        .eq('pairing_code_hash', sha256(code)).gt('pairing_expires_at', new Date().toISOString()).maybeSingle();
    if (error || !source) return res.status(400).json({ error: 'Kopplungscode ist ungültig oder abgelaufen.' });
    const token = crypto.randomBytes(32).toString('base64url');
    const { error: updateError } = await supabase.from('telemetry_sources').update({
        token_hash: sha256(token), pairing_code_hash: null, pairing_expires_at: null,
        paired_at: new Date().toISOString(), device_id: String(req.body?.device_id || '').slice(0, 120),
    }).eq('id', source.id);
    if (updateError) return res.status(500).json({ error: 'Kopplung konnte nicht gespeichert werden.' });
    res.json({ token, source_id: source.id });
});

app.post('/api/telemetry/ingest', async (req, res) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Telemetrie-Token fehlt.' });
    const { data: source, error } = await supabase.from('telemetry_sources').select('id').eq('token_hash', sha256(token)).maybeSingle();
    if (error || !source) return res.status(401).json({ error: 'Telemetrie-Token ist ungültig.' });
    const payload = req.body;
    if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.fields) || !Array.isArray(payload.vehicles)) {
        return res.status(400).json({ error: 'Ungültiges Telemetrieformat.' });
    }
    const now = new Date().toISOString();
    const { error: saveError } = await supabase.from('telemetry_sources').update({ last_payload: payload, last_seen_at: now }).eq('id', source.id);
    if (saveError) return res.status(500).json({ error: 'Telemetrie konnte nicht gespeichert werden.' });
    const events = Array.isArray(payload.financeEvents) ? payload.financeEvents.slice(0, 100) : [];
    if (events.length) {
        const rows = events.filter((e) => e?.id && Number.isFinite(Number(e.amount))).map((e) => ({
            external_id: `${source.id}:${String(e.id).slice(0, 160)}`, occurred_at: e.occurredAt || now,
            category: String(e.category || 'other').slice(0, 50), description: String(e.description || 'FS25 Buchung').slice(0, 240),
            amount: Number(e.amount), balance_after: e.balanceAfter == null ? null : Number(e.balanceAfter), currency: e.currency || 'USD',
            metadata: { source_id: source.id },
        }));
        if (rows.length) await supabase.from('finance_transactions').upsert(rows, { onConflict: 'external_id', ignoreDuplicates: true });
    }
    broadcast('telemetry-changed', { sourceId: source.id, receivedAt: now });
    res.json({ success: true, received_at: now });
});

app.get('/api/telemetry/state', requireApprovedPermission(), async (req, res) => {
    const { data, error } = await supabase.from('telemetry_sources').select('source_name,last_seen_at,last_payload')
        .not('last_payload', 'is', null).order('last_seen_at', { ascending: false }).limit(1).maybeSingle();
    if (error) return res.status(500).json({ error: 'Telemetriedaten konnten nicht geladen werden.' });
    res.json({ payload: data?.last_payload || null, source_name: data?.source_name || null, last_seen_at: data?.last_seen_at || null,
        connected: Boolean(data?.last_seen_at && Date.now() - new Date(data.last_seen_at).getTime() < 90000) });
});

app.get('/api/admin/users', requireApprovedPermission('can_manage_users'), async (req, res) => {
    const { data: users, error } = await supabase
        .from('discord_users')
        .select('discord_id,username,global_name,avatar_hash,status,is_admin,can_create_tasks,can_delete_tasks,can_manage_users,created_at,updated_at')
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: 'Benutzer konnten nicht geladen werden.' });
    res.json({
        users: users.map((user) => ({
            ...user,
            display_name: user.global_name || user.username,
            avatar: avatarUrlFromRecord(user),
            is_super_admin: user.discord_id === ADMIN_DISCORD_ID,
        })),
    });
});

app.patch('/api/admin/users/:discordId/status', requireApprovedPermission('can_manage_users'), async (req, res) => {
    const targetDiscordId = String(req.params.discordId || '');
    const status = String(req.body.status || '');
    if (!/^\d{17,20}$/.test(targetDiscordId)) return res.status(400).json({ error: 'Ungültige Discord-ID.' });
    if (!['pending', 'approved', 'rejected', 'blocked'].includes(status)) {
        return res.status(400).json({ error: 'Ungültiger Benutzerstatus.' });
    }
    if (targetDiscordId === ADMIN_DISCORD_ID) {
        return res.status(400).json({ error: 'Der Hauptadmin kann nicht gesperrt oder abgelehnt werden.' });
    }
    if (targetDiscordId === req.session.user.id) {
        return res.status(400).json({ error: 'Du kannst deinen eigenen Zugang nicht ändern.' });
    }

    const { data: user, error } = await supabase
        .from('discord_users')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('discord_id', targetDiscordId)
        .select('discord_id,status')
        .single();

    if (error) return res.status(500).json({ error: 'Benutzerstatus konnte nicht gespeichert werden.' });
    broadcast('users-changed', { userId: targetDiscordId });
    res.json({ user });
});

app.patch('/api/admin/users/:discordId/permissions', requireApprovedPermission('can_manage_users'), async (req, res) => {
    if (!req.session.user.is_super_admin) {
        return res.status(403).json({ error: 'Nur der Hauptadmin darf Rechte vergeben.' });
    }

    const targetDiscordId = String(req.params.discordId || '');
    if (!/^\d{17,20}$/.test(targetDiscordId)) return res.status(400).json({ error: 'Ungültige Discord-ID.' });
    if (targetDiscordId === ADMIN_DISCORD_ID) {
        return res.status(400).json({ error: 'Die Rechte des Hauptadmins sind fest vergeben.' });
    }

    const permissions = req.body.permissions || {};
    const update = {
        can_create_tasks: permissions.can_create_tasks === true,
        can_delete_tasks: permissions.can_delete_tasks === true,
        can_manage_users: permissions.can_manage_users === true,
        updated_at: new Date().toISOString(),
    };
    const { data: user, error } = await supabase
        .from('discord_users')
        .update(update)
        .eq('discord_id', targetDiscordId)
        .select('discord_id,can_create_tasks,can_delete_tasks,can_manage_users')
        .single();

    if (error) return res.status(500).json({ error: 'Berechtigungen konnten nicht gespeichert werden.' });
    broadcast('users-changed', { userId: targetDiscordId });
    res.json({ user });
});

app.get('/api/tasks', requireApprovedPermission(), async (req, res) => {
    const { data: tasks, error } = await supabase.from('tasks').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Aufgaben konnten nicht geladen werden.' });
    res.json({
        tasks: tasks.map((task) => ({
            id: task.id,
            name: task.task_name,
            field: task.field_number,
            player: task.player_name,
            urgency: task.priority,
            done: task.is_completed,
        })),
    });
});

app.post('/api/tasks', requireApprovedPermission('can_create_tasks'), async (req, res) => {
    const name = String(req.body.name || '').trim();
    const player = String(req.body.player || '').trim();
    const field = req.body.field === null || req.body.field === '' ? null : Number(req.body.field);
    const urgency = String(req.body.urgency || 'medium');
    if (!name || name.length > 120) return res.status(400).json({ error: 'Der Aufgabenname ist ungültig.' });
    if (player.length > 64) return res.status(400).json({ error: 'Der Spielername ist zu lang.' });
    if (field !== null && (!Number.isInteger(field) || field < 1 || field > 999)) {
        return res.status(400).json({ error: 'Die Feldnummer ist ungültig.' });
    }
    if (!['low', 'medium', 'high'].includes(urgency)) return res.status(400).json({ error: 'Die Dringlichkeit ist ungültig.' });

    const { data: task, error } = await supabase.from('tasks').insert({
        task_name: name,
        field_number: field,
        player_name: player,
        priority: urgency,
        is_completed: false,
        created_by: req.session.user.id,
    }).select('*').single();

    if (error) return res.status(500).json({ error: 'Aufgabe konnte nicht erstellt werden.' });
    broadcast('tasks-changed', { action: 'created', taskId: task.id });
    res.status(201).json({ task });
});

app.patch('/api/tasks/:id', requireApprovedPermission(), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1 || typeof req.body.done !== 'boolean') {
        return res.status(400).json({ error: 'Ungültige Aufgabe.' });
    }

    const { data: task, error } = await supabase
        .from('tasks')
        .update({ is_completed: req.body.done, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('*')
        .single();
    if (error) return res.status(500).json({ error: 'Aufgabe konnte nicht aktualisiert werden.' });
    broadcast('tasks-changed', { action: 'updated', taskId: task.id });
    res.json({ task });
});

app.delete('/api/tasks/completed', requireApprovedPermission('can_delete_tasks'), async (req, res) => {
    const { error } = await supabase.from('tasks').delete().eq('is_completed', true);
    if (error) return res.status(500).json({ error: 'Erledigte Aufgaben konnten nicht gelöscht werden.' });
    broadcast('tasks-changed', { action: 'completed-cleared' });
    res.json({ success: true });
});

app.delete('/api/tasks/:id', requireApprovedPermission('can_delete_tasks'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültige Aufgabe.' });
    const { error } = await supabase.from('tasks').delete().eq('id', id);
    if (error) return res.status(500).json({ error: 'Aufgabe konnte nicht gelöscht werden.' });
    broadcast('tasks-changed', { action: 'deleted', taskId: id });
    res.json({ success: true });
});

app.post('/api/presence', requireApprovedPermission(), async (req, res) => {
    const now = new Date().toISOString();
    const { error } = await supabase
        .from('discord_users')
        .update({ last_seen_at: now, updated_at: now })
        .eq('discord_id', req.session.user.id);

    if (error) return res.status(500).json({ error: 'Online-Status konnte nicht aktualisiert werden.' });
    broadcast('presence-changed', { userId: req.session.user.id });
    res.json({ success: true, last_seen_at: now });
});

app.get('/api/online-users', requireApprovedPermission(), async (req, res) => {
    const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: users, error } = await supabase
        .from('discord_users')
        .select('discord_id,username,global_name,avatar_hash,last_seen_at')
        .eq('status', 'approved')
        .gte('last_seen_at', cutoff)
        .order('last_seen_at', { ascending: false });

    if (error) return res.status(500).json({ error: 'Online-Nutzer konnten nicht geladen werden.' });
    res.json({
        users: users.map((user) => ({
            id: user.discord_id,
            username: user.global_name || user.username,
            avatar: avatarUrlFromRecord(user),
            last_seen_at: user.last_seen_at,
        })),
    });
});

app.get('/api/finances/summary', requireApprovedPermission(), async (req, res) => {
    const weekStart = new Date();
    weekStart.setUTCDate(weekStart.getUTCDate() - 7);

    const [weekResult, latestResult, telemetryResult] = await Promise.all([
        supabase.from('finance_transactions').select('amount').gte('occurred_at', weekStart.toISOString()),
        supabase.from('finance_transactions').select('balance_after,currency,occurred_at').order('occurred_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('telemetry_sources').select('last_payload,last_seen_at').not('last_payload', 'is', null).order('last_seen_at', { ascending: false }).limit(1).maybeSingle(),
    ]);

    if (weekResult.error || latestResult.error || telemetryResult.error) {
        return res.status(500).json({ error: 'Finanzübersicht konnte nicht geladen werden.' });
    }

    const amounts = (weekResult.data || []).map((row) => Number(row.amount) || 0);
    const income = amounts.filter((amount) => amount > 0).reduce((sum, amount) => sum + amount, 0);
    const expenses = amounts.filter((amount) => amount < 0).reduce((sum, amount) => sum + Math.abs(amount), 0);
    res.json({
        telemetry_connected: Boolean(telemetryResult.data),
        balance: telemetryResult.data?.last_payload?.farm?.money ?? latestResult.data?.balance_after ?? null,
        income,
        expenses,
        net: income - expenses,
        currency: latestResult.data?.currency || 'USD',
        updated_at: telemetryResult.data?.last_seen_at || latestResult.data?.occurred_at || null,
    });
});

app.get('/api/finances/transactions', requireApprovedPermission(), async (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 250);
    const { data: transactions, error } = await supabase
        .from('finance_transactions')
        .select('id,occurred_at,category,description,amount,balance_after,currency')
        .order('occurred_at', { ascending: false })
        .limit(limit);

    if (error) return res.status(500).json({ error: 'Finanztransaktionen konnten nicht geladen werden.' });
    res.json({ transactions });
});

app.get('/api/public-config', (req, res) => {
    res.json({
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    });
});

app.get('/api/auth/logout', async (req, res) => {
    if (req.session.user?.id) {
        await supabase.from('discord_users').update({ last_seen_at: null }).eq('discord_id', req.session.user.id);
        broadcast('presence-changed', { userId: req.session.user.id });
    }
    req.session.destroy(() => {
        res.clearCookie('fs25.sid');
        res.redirect('/');
    });
});

app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/admin', requireApprovedPermission('can_manage_users'), (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});
app.get('/admin.html', (req, res) => res.redirect('/admin'));
app.get('/finances', requireApprovedPermission(), (req, res) => {
    res.sendFile(path.join(__dirname, 'finances.html'));
});
app.get('/finances.html', (req, res) => res.redirect('/finances'));
app.use(express.static(path.join(__dirname)));

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Server läuft auf Port ${port}`));
