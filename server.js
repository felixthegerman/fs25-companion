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
    return {
        id: databaseUser.discord_id,
        username: databaseUser.global_name || databaseUser.username,
        avatar: databaseUser.avatar_url,
        status: databaseUser.status,
        is_approved: databaseUser.status === 'approved',
        is_admin: databaseUser.is_admin,
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

app.post('/api/admin/approve', async (req, res) => {
    if (!req.session.user?.is_admin) return res.status(403).json({ error: 'Unauthorized' });

    const { target_discord_id: targetDiscordId, approve } = req.body;
    if (!/^\d{17,20}$/.test(String(targetDiscordId || ''))) {
        return res.status(400).json({ error: 'Ungültige Discord-ID' });
    }
    if (String(targetDiscordId) === req.session.user.id) {
        return res.status(400).json({ error: 'Der Admin kann sich nicht selbst sperren.' });
    }

    const { error } = await supabase
        .from('discord_users')
        .update({
            status: approve ? 'approved' : 'blocked',
            updated_at: new Date().toISOString(),
        })
        .eq('discord_id', String(targetDiscordId));

    if (error) return res.status(500).json({ error: 'Freigabe konnte nicht gespeichert werden.' });
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
