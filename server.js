require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// VERIFIKATION DER VARIABLEN (Verhindert Absturz und zeigt genauen Fehler im Log)
const supabaseUrl = process.env.SUPABASE_URL;
// .env / README verwenden SUPABASE_SECRET_KEY - mit Fallback auf den alten Namen, falls irgendwo noch so gesetzt.
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ CRITICAL ERROR: Supabase-Schlüssel wurden von Render nicht geladen!");
    console.error("Bitte überprüfe deine Umgebungsvariablen im Render-Dashboard auf Rechtschreibung:");
    console.error("SUPABASE_URL =", supabaseUrl ? "✅ Geladen" : "❌ FEHLT ODER LEER");
    console.error("SUPABASE_SECRET_KEY =", supabaseKey ? "✅ Geladen" : "❌ FEHLT ODER LEER");
    process.exit(1); 
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Supabase Client mit den verifizierten Variablen erstellen
const supabase = createClient(supabaseUrl, supabaseKey);

app.use(session({
    secret: 'fs25-tracker-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Auf true setzen, falls du später HTTPS nutzt
}));

// API: Discord Login-Weiterleitung
app.get('/api/auth/login', (req, res) => {
    const redirectUri = encodeURIComponent(process.env.DISCORD_REDIRECT_URI);
    const url = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&scope=identify`;
    res.redirect(url);
});

// API: Discord OAuth2 Callback
app.get('/api/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/?error=no_code');

    try {
        // Token von Discord holen
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: process.env.DISCORD_CLIENT_ID,
            client_secret: process.env.DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: process.env.DISCORD_REDIRECT_URI,
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        // User-Daten abfragen
        const userResponse = await axios.get('https://discord.com/api/users/@me', {
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
            avatar: `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`,
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

// Health-Check für Render (siehe render.yaml -> healthCheckPath)
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.listen(process.env.PORT || 10000, () => console.log(`Server läuft auf Port ${process.env.PORT || 10000}`));
