require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(session({
    secret: 'fs25-tracker-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Auf true setzen, falls du später HTTPS (Production) nutzt
}));

// API: Discord Login-Weiterleitung
app.get('/api/auth/login', (req, res) => {
    const redirectUri = encodeURIComponent(process.env.DISCORD_REDIRECT_URI);
    const url = `https://discord.com{process.env.DISCORD_CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&scope=identify`;
    res.redirect(url);
});

// API: Discord OAuth2 Callback
app.get('/api/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/?error=no_code');

    try {
        // Token von Discord holen
        const tokenResponse = await axios.post('https://discord.com', new URLSearchParams({
            client_id: process.env.DISCORD_CLIENT_ID,
            client_secret: process.env.DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: process.env.DISCORD_REDIRECT_URI,
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        // User-Daten abfragen
        const userResponse = await axios.get('https://discord.com', {
            headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` }
        });

        const discordUser = userResponse.data;
        const isAdmin = discordUser.id === process.env.ADMIN_DISCORD_ID;

        // In Supabase prüfen oder neu anlegen
        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('discord_id', discordUser.id)
            .single();

        if (!user) {
            await supabase.from('users').insert({
                discord_id: discordUser.id,
                username: discordUser.username,
                avatar: discordUser.avatar,
                is_approved: isAdmin, // Admin ist automatisch freigeschaltet
                is_admin: isAdmin
            });
        }

        // Session setzen
        req.session.user = {
            id: discordUser.id,
            username: discordUser.username,
            avatar: `https://discordapp.com{discordUser.id}/${discordUser.avatar}.png`,
            is_approved: user ? user.is_approved : isAdmin,
            is_admin: isAdmin
        };

        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.redirect('/?error=auth_failed');
    }
});

// API: Aktuellen Session-Status abfragen
app.get('/api/auth/me', (req, res) => {
    if (!req.session.user) return res.json({ loggedIn: false });
    res.json({ loggedIn: true, user: req.session.user });
});

// API: Admin schaltet Spieler frei
app.post('/api/admin/approve', async (req, res) => {
    if (!req.session.user || !req.session.user.is_admin) return res.status(403).json({ error: 'Unauthorized' });
    const { target_discord_id, approve } = req.body;
    
    const { error } = await supabase
        .from('users')
        .update({ is_approved: approve })
        .eq('discord_id', target_discord_id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// API: Logout
app.get('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.listen(process.env.PORT, () => console.log(`Server läuft auf Port ${process.env.PORT}`));
