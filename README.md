# FS25 Companion — Discord OAuth2 + Admin Approval

Dieses Projekt setzt dein vorhandenes `index.html` um und ergänzt:

- Discord OAuth2 Authorization-Code-Login
- neue Spieler zunächst `pending`
- Admin-Freigabe über deine feste Discord-ID `1124793204588433518`
- Status `pending / approved / blocked`
- Discord-Username + Avatar + grünes `● Online` im Header
- verstecktes Admin-Panel nur für den Admin
- Supabase als persistente Datenbank
- eine gemeinsame Express-App für Frontend und Backend, damit Sessions same-origin bleiben

## Empfohlener kostenloser Aufbau

Für dieses konkrete Projekt ist ein einzelner **Render Web Service + Supabase Free** am einfachsten. Der Express-Server liefert `index.html` aus und stellt `/api/*` bereit. Dadurch gibt es keine Cross-Origin-Cookie-Probleme.

Render Free schläft bei Inaktivität ein. Das kann beim ersten Aufruf ungefähr eine Minute Startzeit bedeuten. Die Free-Instanz ist laut Render für Hobby-/Testprojekte gedacht. Supabase Free bietet aktuell zwei kostenlose Projekte.

## 1. Supabase

1. Neues Supabase-Projekt anlegen.
2. SQL Editor öffnen.
3. Inhalt aus `supabase/schema.sql` ausführen.
4. Unter **Project Settings -> API** die Projekt-URL und den serverseitigen Secret Key kopieren.
5. Den Secret Key ausschließlich als Backend-Environment-Variable verwenden.

## 2. Discord Developer Portal

1. Eine Application im Discord Developer Portal anlegen.
2. Unter **OAuth2** die Redirect URL eintragen:
   - lokal: `http://localhost:3000/api/auth/callback`
   - Produktion: `https://DEIN-RENDER-NAME.onrender.com/api/auth/callback`
3. `Client ID` und `Client Secret` bereithalten.
4. Für dieses Backend **Public Client aus lassen**. Das Projekt verwendet den serverseitigen Authorization-Code-Flow.
5. Im OAuth2-Login wird nur der Scope `identify` angefordert.

Wichtig: Die Redirect URL muss mit der in Discord registrierten URL übereinstimmen.

## 3. Lokal testen

```bash
npm install
cp .env.example .env
```

In `.env` eintragen:

```env
APP_URL=http://localhost:3000
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
ADMIN_DISCORD_ID=1124793204588433518
SESSION_SECRET=...
SUPABASE_URL=...
SUPABASE_SECRET_KEY=...
# Optional für die Live-Feldansicht im Browser (der öffentliche Anon-Key, nie der Secret Key):
SUPABASE_ANON_KEY=...
```

Dann:

```bash
npm start
```

Öffne danach `http://localhost:3000`.

Nicht direkt per `file://.../index.html` öffnen, weil der OAuth-Callback zum Express-Server geht.

## 4. Render kostenlos deployen

Am einfachsten ist GitHub + Render:

1. Diesen Projektordner in ein GitHub-Repository pushen.
2. In Render **New -> Web Service** wählen und das Repository verbinden.
3. Build command: `npm install`
4. Start command: `npm start`
5. Plan: **Free**
6. Environment Variables setzen:
   - `APP_URL=https://DEIN-RENDER-NAME.onrender.com`
   - `DISCORD_CLIENT_ID=...`
   - `DISCORD_CLIENT_SECRET=...`
   - `ADMIN_DISCORD_ID=1124793204588433518`
   - `SESSION_SECRET=...`
   - `SUPABASE_URL=...`
   - `SUPABASE_SECRET_KEY=...`
   - optional `SUPABASE_ANON_KEY=...` für die Live-Feldansicht
7. Deploy starten.
8. Danach die Produktion-Callback-URL im Discord Developer Portal exakt auf `APP_URL + /api/auth/callback` setzen.

## 5. Ablauf

1. Besucher öffnet die Seite -> Dashboard ist unscharf im Hintergrund.
2. Klick auf `Mit Discord anmelden` -> Discord OAuth2.
3. Backend tauscht den Code serverseitig gegen ein Zugriffstoken und liest `/users/@me`.
4. Der Discord-Nutzer wird in Supabase angelegt, falls er noch nicht existiert.
5. Neue Nutzer bekommen `pending`.
6. Dein Admin-Login wird über `1124793204588433518` automatisch als `approved + admin` erkannt.
7. Im Admin-Panel kannst du andere Nutzer zulassen oder sperren.
8. Ein freigegebener Nutzer sieht oben Avatar, Discord-Name und `● Online`.
9. Ein blockierter Nutzer wird bei der nächsten Statusabfrage wieder gesperrt.

## Admin-Dashboard und Berechtigungen

Der Hauptadmin wird ausschließlich über `ADMIN_DISCORD_ID=1124793204588433518` erkannt und erhält immer alle Rechte. Nach dem Login erscheint in der Navigation der Bereich **Admin**.

Dort kann der Hauptadmin:

- alle Nutzer sehen,
- wartende Nutzer annehmen oder ablehnen,
- bereits freigeschaltete Nutzer sperren,
- Nutzer wieder auf `wartend` setzen,
- die Rechte `Aufgaben erstellen`, `Aufgaben löschen` und `Nutzer verwalten` einzeln vergeben.

Nutzer mit `Nutzer verwalten` dürfen das Admin-Dashboard öffnen und Zugangsstatus ändern. Nur der feste Hauptadmin darf Berechtigungen weitergeben oder entziehen. Aufgaben werden serverseitig in Supabase gespeichert, damit diese Rechte nicht im Browser umgangen werden können.

Nach diesem Update muss `supabase/schema.sql` erneut vollständig im Supabase SQL Editor ausgeführt werden. Das Skript aktualisiert bestehende Installationen idempotent und legt die neue `tasks`-Tabelle sowie die Berechtigungsspalten an.

## Sicherheitsdetails

- `DISCORD_CLIENT_SECRET` bleibt auf dem Server.
- `SUPABASE_SECRET_KEY` bleibt auf dem Server.
- Session ist ein signiertes HttpOnly-Cookie; es wird kein Discord Access Token im Browser-LocalStorage gespeichert.
- OAuth-`state` wird geprüft.
- Admin-Endpunkte prüfen die feste Admin-Discord-ID serverseitig.
- Der Admin kann sich selbst nicht auf `blocked` setzen.

### Wichtig für den späteren Live-Spielstand

Das aktuelle Dashboard enthält weiterhin deine bisherigen Mock-Daten im HTML/JavaScript. Ein UI-Overlay ist kein Geheimschutz für bereits ausgelieferte statische Daten: Jeder Besucher kann den HTML/JS-Code grundsätzlich herunterladen.

Sobald echte FS25-Save-/Telemetry-Daten angebunden werden, sollten diese Daten über geschützte `/api/...`-Endpunkte kommen und serverseitig gegen die Session + den Freigabestatus geprüft werden. Genau dafür ist die Trennung zwischen Browser und Express-Backend bereits vorbereitet.
