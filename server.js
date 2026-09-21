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
    const schemaReady = Object.prototype.hasOwnProperty.call(databaseUser, 'can_manage_users')
        && Object.prototype.hasOwnProperty.call(databaseUser, 'can_view_archive')
        && Object.prototype.hasOwnProperty.call(databaseUser, 'can_edit_archive')
        && Object.prototype.hasOwnProperty.call(databaseUser, 'can_delete_archive');
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
            can_view_archive: isSuperAdmin || Boolean(databaseUser.can_view_archive) || Boolean(databaseUser.can_edit_archive) || Boolean(databaseUser.can_delete_archive),
            can_edit_archive: isSuperAdmin || Boolean(databaseUser.can_edit_archive),
            can_delete_archive: isSuperAdmin || Boolean(databaseUser.can_delete_archive),
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
            const allowed = Array.isArray(permission)
                ? permission.some((key) => req.session.user.permissions[key])
                : !permission || req.session.user.permissions[permission];
            if (!allowed) {
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
            can_view_archive: isAdmin || Boolean(existingUser?.can_view_archive),
            can_edit_archive: isAdmin || Boolean(existingUser?.can_edit_archive),
            can_delete_archive: isAdmin || Boolean(existingUser?.can_delete_archive),
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
    if (!payload || ![1, 2, 3].includes(payload.schemaVersion) || !Array.isArray(payload.fields) || !Array.isArray(payload.vehicles)) {
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
        if (rows.length) {
            // Keep the first timestamp stable while a running FS25 transaction
            // (for example refuelling) updates its final amount.
            const externalIds = rows.map((row) => row.external_id);
            const { data: existing, error: lookupError } = await supabase.from('finance_transactions')
                .select('external_id,occurred_at').in('external_id', externalIds);
            if (lookupError) return res.status(500).json({ error: 'Finanzbuchungen konnten nicht geprüft werden.' });
            const occurredById = new Map((existing || []).map((row) => [row.external_id, row.occurred_at]));
            rows.forEach((row) => { if (occurredById.has(row.external_id)) row.occurred_at = occurredById.get(row.external_id); });
            const { error: financeError } = await supabase.from('finance_transactions').upsert(rows, { onConflict: 'external_id', ignoreDuplicates: false });
            if (financeError) return res.status(500).json({ error: 'Finanzbuchungen konnten nicht gespeichert werden. Bitte supabase/schema.sql erneut ausführen.' });
        }
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
        .select('discord_id,username,global_name,avatar_hash,status,is_admin,can_create_tasks,can_delete_tasks,can_manage_users,can_view_archive,can_edit_archive,can_delete_archive,created_at,updated_at')
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

app.get('/api/admin/task-archive', requireApprovedPermission(['can_view_archive', 'can_edit_archive', 'can_delete_archive']), async (req, res) => {
    const { data: archive, error } = await supabase.from('task_archive').select('*')
        .order('deleted_at', { ascending: false }).limit(500);
    if (error) return res.status(500).json({ error: 'Aufgabenarchiv konnte nicht geladen werden. Bitte supabase/tasks-upgrade.sql ausführen.' });
    res.json({ archive: archive || [] });
});

app.patch('/api/admin/task-archive/:id', requireApprovedPermission('can_edit_archive'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültiger Archiveintrag.' });
    const { data: row, error: loadError } = await supabase.from('task_archive').select('task_snapshot').eq('id', id).maybeSingle();
    if (loadError || !row) return res.status(404).json({ error: 'Archiveintrag wurde nicht gefunden.' });
    const snapshot = { ...(row.task_snapshot || {}) };
    if (typeof req.body.task_name === 'string') snapshot.task_name = req.body.task_name.trim().slice(0, 120) || snapshot.task_name;
    if (req.body.field_number === null || Number.isInteger(Number(req.body.field_number))) snapshot.field_number = req.body.field_number === null ? null : Number(req.body.field_number);
    if (TASK_TYPES.includes(String(req.body.task_type))) snapshot.task_type = String(req.body.task_type);
    if (['low', 'medium', 'high'].includes(String(req.body.priority))) snapshot.priority = String(req.body.priority);
    if (typeof req.body.is_completed === 'boolean') snapshot.is_completed = req.body.is_completed;
    snapshot.archive_edited_at = new Date().toISOString();
    snapshot.archive_edited_by = req.session.user.id;
    const { data: archive, error } = await supabase.from('task_archive').update({ task_snapshot: snapshot }).eq('id', id).select('*').single();
    if (error) return res.status(500).json({ error: 'Archiveintrag konnte nicht bearbeitet werden.' });
    broadcast('tasks-changed', { action: 'archive-edited', archiveId: id });
    res.json({ archive });
});

app.delete('/api/admin/task-archive/:id', requireApprovedPermission('can_delete_archive'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültiger Archiveintrag.' });
    const { error } = await supabase.from('task_archive').delete().eq('id', id);
    if (error) return res.status(500).json({ error: 'Archiveintrag konnte nicht gelöscht werden.' });
    broadcast('tasks-changed', { action: 'archive-deleted', archiveId: id });
    res.json({ success: true });
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
        can_view_archive: permissions.can_view_archive === true,
        can_edit_archive: permissions.can_edit_archive === true,
        can_delete_archive: permissions.can_delete_archive === true,
        updated_at: new Date().toISOString(),
    };
    const { data: user, error } = await supabase
        .from('discord_users')
        .update(update)
        .eq('discord_id', targetDiscordId)
        .select('discord_id,can_create_tasks,can_delete_tasks,can_manage_users,can_view_archive,can_edit_archive,can_delete_archive')
        .single();

    if (error) return res.status(500).json({ error: 'Berechtigungen konnten nicht gespeichert werden.' });
    broadcast('users-changed', { userId: targetDiscordId });
    res.json({ user });
});

const TASK_TYPES = ['field', 'animal', 'vehicle', 'transport', 'production', 'maintenance', 'other'];
async function normalizeTaskAssignees(input) {
    if (!Array.isArray(input)) return [];
    const ids = [...new Set(input.slice(0, 12).map((entry) => String(entry?.id || '')).filter((id) => /^\d{17,20}$/.test(id)))];
    if (!ids.length) return [];
    const { data: users, error } = await supabase.from('discord_users').select('discord_id,username,global_name,status').in('discord_id', ids).eq('status', 'approved');
    if (error) throw new Error('Website-Nutzer konnten nicht geprüft werden.');
    return (users || []).map((user) => ({ assignee_key: `discord:${user.discord_id}`, discord_id: user.discord_id,
        display_name: user.global_name || user.username, is_claimed: false }));
}
function taskJson(task, currentUserId) {
    const assignees = (task.task_assignees || []).map((entry) => ({
        key: entry.assignee_key, id: entry.discord_id, name: entry.display_name,
        claimed: Boolean(entry.is_claimed), mine: entry.discord_id === currentUserId,
    }));
    return { id: task.id, name: task.task_name, field: task.field_number, player: task.player_name,
        type: task.task_type || 'field', urgency: task.priority, done: task.is_completed,
        createdBy: task.created_by, assignees, claimedByMe: assignees.some((entry) => entry.mine && entry.claimed) };
}

async function archiveTasks(taskRows, deletedBy) {
    if (!taskRows?.length) return;
    const ids = taskRows.map((task) => task.id);
    const { data: assignees, error: assigneeError } = await supabase.from('task_assignees').select('*').in('task_id', ids);
    if (assigneeError) throw new Error('Aufgabenzuweisungen konnten nicht archiviert werden.');
    const byTask = new Map();
    (assignees || []).forEach((entry) => {
        const key = String(entry.task_id);
        if (!byTask.has(key)) byTask.set(key, []);
        byTask.get(key).push(entry);
    });
    const rows = taskRows.map((task) => ({
        original_task_id: task.id,
        deleted_by: deletedBy,
        task_snapshot: { ...task, assignees: byTask.get(String(task.id)) || [] },
    }));
    const { error } = await supabase.from('task_archive').insert(rows);
    if (error) throw new Error('Aufgabenarchiv fehlt. Bitte supabase/tasks-upgrade.sql ausführen.');
}

app.get('/api/tasks', requireApprovedPermission(), async (req, res) => {
    const { data: tasks, error } = await supabase.from('tasks').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Aufgaben konnten nicht geladen werden.' });
    const ids = (tasks || []).map((task) => task.id);
    let assignees = [], migrationRequired = false;
    const assigneeQuery = supabase.from('task_assignees').select('*');
    const result = ids.length ? await assigneeQuery.in('task_id', ids) : await assigneeQuery.limit(1);
    if (result.error) migrationRequired = true;
    else if (ids.length) assignees = result.data || [];
    const byTask = new Map();
    assignees.forEach((entry) => { if (!byTask.has(String(entry.task_id))) byTask.set(String(entry.task_id), []); byTask.get(String(entry.task_id)).push(entry); });
    res.json({ tasks: (tasks || []).map((task) => taskJson({ ...task, task_assignees: byTask.get(String(task.id)) || [] }, req.session.user.id)), migrationRequired });
});

app.post('/api/tasks', requireApprovedPermission('can_create_tasks'), async (req, res) => {
    const name = String(req.body.name || '').trim();
    const player = String(req.body.player || '').trim();
    const field = req.body.field === null || req.body.field === '' ? null : Number(req.body.field);
    const urgency = String(req.body.urgency || 'medium');
    const taskType = String(req.body.type || 'field');
    let assignees;
    try { assignees = await normalizeTaskAssignees(req.body.assignees); }
    catch (error) { return res.status(500).json({ error: error.message }); }
    if (!name || name.length > 120) return res.status(400).json({ error: 'Der Aufgabenname ist ungültig.' });
    if (player.length > 64) return res.status(400).json({ error: 'Der Spielername ist zu lang.' });
    if (field !== null && (!Number.isInteger(field) || field < 1 || field > 999)) {
        return res.status(400).json({ error: 'Die Feldnummer ist ungültig.' });
    }
    if (!['low', 'medium', 'high'].includes(urgency)) return res.status(400).json({ error: 'Die Dringlichkeit ist ungültig.' });
    if (!TASK_TYPES.includes(taskType)) return res.status(400).json({ error: 'Die Aufgabenart ist ungültig.' });

    const { data: task, error } = await supabase.from('tasks').insert({
        task_name: name,
        field_number: field,
        player_name: assignees.map((entry) => entry.display_name).join(', ') || player,
        task_type: taskType,
        priority: urgency,
        is_completed: false,
        created_by: req.session.user.id,
    }).select('*').single();

    if (error) return res.status(500).json({ error: 'Aufgabe konnte nicht erstellt werden. Bitte supabase/tasks-upgrade.sql ausführen.' });
    if (assignees.length) {
        const { error: assigneeError } = await supabase.from('task_assignees').insert(assignees.map((entry) => ({ ...entry, task_id: task.id })));
        if (assigneeError) return res.status(500).json({ error: 'Beteiligte konnten nicht gespeichert werden. Bitte supabase/tasks-upgrade.sql ausführen.' });
    }
    broadcast('tasks-changed', { action: 'created', taskId: task.id });
    res.status(201).json({ task });
});

app.patch('/api/tasks/:id/details', requireApprovedPermission('can_create_tasks'), async (req, res) => {
    const id = Number(req.params.id), name = String(req.body.name || '').trim();
    const field = req.body.field === null || req.body.field === '' ? null : Number(req.body.field);
    const urgency = String(req.body.urgency || 'medium'), taskType = String(req.body.type || 'field');
    let assignees;
    try { assignees = await normalizeTaskAssignees(req.body.assignees); }
    catch (error) { return res.status(500).json({ error: error.message }); }
    if (!Number.isInteger(id) || id < 1 || !name || name.length > 120) return res.status(400).json({ error: 'Ungültige Aufgabe.' });
    if (field !== null && (!Number.isInteger(field) || field < 1 || field > 999)) return res.status(400).json({ error: 'Die Feldnummer ist ungültig.' });
    if (!['low', 'medium', 'high'].includes(urgency) || !TASK_TYPES.includes(taskType)) return res.status(400).json({ error: 'Aufgabenart oder Dringlichkeit ist ungültig.' });
    const { data: task, error } = await supabase.from('tasks').update({ task_name: name, field_number: field,
        player_name: assignees.map((entry) => entry.display_name).join(', '), task_type: taskType, priority: urgency, updated_at: new Date().toISOString() })
        .eq('id', id).select('*').single();
    if (error) return res.status(500).json({ error: 'Aufgabe konnte nicht bearbeitet werden. Bitte supabase/tasks-upgrade.sql ausführen.' });
    await supabase.from('task_assignees').delete().eq('task_id', id).eq('is_claimed', false);
    if (assignees.length) await supabase.from('task_assignees').upsert(assignees.map((entry) => ({ ...entry, task_id: id })), { onConflict: 'task_id,assignee_key', ignoreDuplicates: true });
    broadcast('tasks-changed', { action: 'edited', taskId: id });
    res.json({ task });
});

app.post('/api/tasks/:id/claim', requireApprovedPermission(), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültige Aufgabe.' });
    const { data: task } = await supabase.from('tasks').select('id,is_completed').eq('id', id).maybeSingle();
    if (!task || task.is_completed) return res.status(400).json({ error: 'Diese Aufgabe kann nicht übernommen werden.' });
    const row = { task_id: id, assignee_key: `discord:${req.session.user.id}`, discord_id: req.session.user.id,
        display_name: req.session.user.username, is_claimed: true, assigned_at: new Date().toISOString() };
    const { error } = await supabase.from('task_assignees').upsert(row, { onConflict: 'task_id,assignee_key' });
    if (error) return res.status(500).json({ error: 'Aufgabe konnte nicht übernommen werden.' });
    broadcast('tasks-changed', { action: 'claimed', taskId: id });
    res.json({ success: true });
});

app.delete('/api/tasks/:id/claim', requireApprovedPermission(), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültige Aufgabe.' });
    const { error } = await supabase.from('task_assignees').delete().eq('task_id', id).eq('discord_id', req.session.user.id).eq('is_claimed', true);
    if (error) return res.status(500).json({ error: 'Claim konnte nicht freigegeben werden.' });
    broadcast('tasks-changed', { action: 'unclaimed', taskId: id });
    res.json({ success: true });
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
    const { data: completed, error: loadError } = await supabase.from('tasks').select('*').eq('is_completed', true);
    if (loadError) return res.status(500).json({ error: 'Erledigte Aufgaben konnten nicht geladen werden.' });
    try { await archiveTasks(completed || [], req.session.user.id); }
    catch (error) { return res.status(500).json({ error: error.message }); }
    const { error } = await supabase.from('tasks').delete().eq('is_completed', true);
    if (error) return res.status(500).json({ error: 'Erledigte Aufgaben konnten nicht gelöscht werden.' });
    broadcast('tasks-changed', { action: 'completed-cleared' });
    res.json({ success: true });
});

app.delete('/api/tasks/:id', requireApprovedPermission('can_delete_tasks'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültige Aufgabe.' });
    const { data: task, error: loadError } = await supabase.from('tasks').select('*').eq('id', id).maybeSingle();
    if (loadError) return res.status(500).json({ error: 'Aufgabe konnte nicht geladen werden.' });
    if (!task) return res.status(404).json({ error: 'Aufgabe wurde nicht gefunden.' });
    try { await archiveTasks([task], req.session.user.id); }
    catch (error) { return res.status(500).json({ error: error.message }); }
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

app.get('/api/users/assignable', requireApprovedPermission(), async (req, res) => {
    const { data: users, error } = await supabase.from('discord_users')
        .select('discord_id,username,global_name').eq('status', 'approved').order('global_name', { ascending: true });
    if (error) return res.status(500).json({ error: 'Zuweisbare Nutzer konnten nicht geladen werden.' });
    res.json({ users: users.map((user) => ({ id: user.discord_id, name: user.global_name || user.username })) });
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
    const grouped = [];
    for (const transaction of transactions || []) {
        const previous = grouped[grouped.length - 1];
        const runningCost = transaction.category === 'refuel' || ['Fahrzeugkosten', 'Leasingkosten'].includes(transaction.description);
        const closeInTime = previous && Math.abs(new Date(previous.occurred_at) - new Date(transaction.occurred_at)) <= 45000;
        if (runningCost && closeInTime && previous.category === transaction.category && previous.description === transaction.description && previous.currency === transaction.currency) {
            previous.amount = Number(previous.amount || 0) + Number(transaction.amount || 0);
        } else {
            grouped.push({ ...transaction });
        }
    }
    res.json({ transactions: grouped });
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
app.get('/admin', requireApprovedPermission(['can_manage_users', 'can_view_archive', 'can_edit_archive', 'can_delete_archive']), (req, res) => {
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
