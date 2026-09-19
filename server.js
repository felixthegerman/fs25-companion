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
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json());
app.use(session({
    name: 'fs25.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
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
    const isSuperAdmin = databaseUser.discord_id === process.env.ADMIN_DISCORD_ID;
    return {
        id: databaseUser.discord_id,
        username: databaseUser.global_name || databaseUser.username,
        avatar: databaseUser.avatar_url,
        status: databaseUser.status,
        is_approved: databaseUser.status === 'approved',
        is_admin: isSuperAdmin || databaseUser.is_admin,
        is_super_admin: isSuperAdmin,
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
        const isAdmin = discordUser.id === process.env.ADMIN_DISCORD_ID;

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
            updated_at: new Date().toISOString(),
        };

        const { data: savedUser, error: upsertError } = await supabase
            .from('discord_users')
            .upsert(userRecord, { onConflict: 'discord_id' })
            .select('*')
            .single();

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
            is_super_admin: user.discord_id === process.env.ADMIN_DISCORD_ID,
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
    if (targetDiscordId === process.env.ADMIN_DISCORD_ID) {
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
    res.json({ user });
});

app.patch('/api/admin/users/:discordId/permissions', requireApprovedPermission('can_manage_users'), async (req, res) => {
    if (!req.session.user.is_super_admin) {
        return res.status(403).json({ error: 'Nur der Hauptadmin darf Rechte vergeben.' });
    }

    const targetDiscordId = String(req.params.discordId || '');
    if (!/^\d{17,20}$/.test(targetDiscordId)) return res.status(400).json({ error: 'Ungültige Discord-ID.' });
    if (targetDiscordId === process.env.ADMIN_DISCORD_ID) {
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
    res.json({ user });
});

app.get('/api/tasks', requireApprovedPermission(), async (req, res) => {
    const { data: tasks, error } = await supabase.from('tasks').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Aufgaben konnten nicht geladen werden.' });
    res.json({
        tasks: tasks.map((task) => ({
            id: task.id,
            name: task.name,
            field: task.field_number,
            player: task.assigned_player,
            urgency: task.urgency,
            done: task.done,
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
        name,
        field_number: field,
        assigned_player: player || null,
        urgency,
        created_by: req.session.user.id,
    }).select('*').single();

    if (error) return res.status(500).json({ error: 'Aufgabe konnte nicht erstellt werden.' });
    res.status(201).json({ task });
});

app.patch('/api/tasks/:id', requireApprovedPermission(), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1 || typeof req.body.done !== 'boolean') {
        return res.status(400).json({ error: 'Ungültige Aufgabe.' });
    }

    const { data: task, error } = await supabase
        .from('tasks')
        .update({ done: req.body.done, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('*')
        .single();
    if (error) return res.status(500).json({ error: 'Aufgabe konnte nicht aktualisiert werden.' });
    res.json({ task });
});

app.delete('/api/tasks/completed', requireApprovedPermission('can_delete_tasks'), async (req, res) => {
    const { error } = await supabase.from('tasks').delete().eq('done', true);
    if (error) return res.status(500).json({ error: 'Erledigte Aufgaben konnten nicht gelöscht werden.' });
    res.json({ success: true });
});

app.delete('/api/tasks/:id', requireApprovedPermission('can_delete_tasks'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültige Aufgabe.' });
    const { error } = await supabase.from('tasks').delete().eq('id', id);
    if (error) return res.status(500).json({ error: 'Aufgabe konnte nicht gelöscht werden.' });
    res.json({ success: true });
});

app.get('/api/public-config', (req, res) => {
    res.json({
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    });
});

app.get('/api/auth/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('fs25.sid');
        res.redirect('/');
    });
});

app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.use(express.static(path.join(__dirname)));

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Server läuft auf Port ${port}`));
