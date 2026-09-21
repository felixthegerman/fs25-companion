# FS25 Companion — Discord OAuth2 + Admin Approval

Dieses Projekt setzt dein vorhandenes `index.html` um und ergänzt:

- Discord OAuth2 Authorization-Code-Login
- neue Spieler zunächst `pending`
- Admin-Freigabe über deine feste Discord-ID `1124793204588433518`
- Status `pending / approved / blocked`
- echte Online-Anzeige aller freigeschalteten Website-Nutzer mit Discord-Avatar
- verstecktes Admin-Panel nur für den Admin
- eigener Finanzbereich für alle freigeschalteten Nutzer
- Live-Synchronisierung von Aufgaben und Benutzeränderungen ohne Neuladen
- persistente, sieben Tage gültige Website-Sitzungen in Supabase
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
8. Freigegebene Nutzer, die die Website gerade geöffnet haben, erscheinen mit ihrem echten Discord-Avatar im Header. Der Status wird alle 30 Sekunden aktualisiert und läuft nach zwei Minuten ohne Aktivität ab.
9. Ein blockierter Nutzer wird bei der nächsten Statusabfrage wieder gesperrt.

## Admin-Dashboard und Berechtigungen

Der Hauptadmin wird über die feste Discord-ID `1124793204588433518` erkannt und erhält immer alle Rechte. Nach dem Login erscheint nur für berechtigte Nutzer in der Navigation der eigene Bereich **Admin** unter `/admin`. Die Seite wird zusätzlich serverseitig geschützt und kann nur mit `Nutzer verwalten` oder mindestens einem Archiv-Recht direkt geöffnet werden.

Die Discord-ID `1124793204588433518` ist zusätzlich fest im Backend abgesichert. Für diesen Nutzer gelten `approved` und alle modularen Rechte daher immer – unabhängig von alten oder fehlerhaften Berechtigungswerten in der Datenbank.

Dort kann der Hauptadmin:

- alle Nutzer sehen,
- wartende Nutzer annehmen oder ablehnen,
- bereits freigeschaltete Nutzer sperren,
- Nutzer wieder auf `wartend` setzen,
- die Rechte `Aufgaben erstellen`, `Aufgaben löschen`, `Nutzer verwalten`, `Archiv ansehen`, `Archiv bearbeiten` und `Archiv endgültig löschen` einzeln vergeben.

Nutzer mit `Nutzer verwalten` dürfen Zugangsstatus ändern. Nutzer mit Archiv-Rechten sehen nur den für sie freigeschalteten Archivbereich. Nur der feste Hauptadmin darf Berechtigungen weitergeben oder entziehen. Aufgaben und Archivänderungen werden serverseitig in Supabase gespeichert, damit diese Rechte nicht im Browser umgangen werden können.

Bei einem bestehenden Deployment genügt für diese neuen Rechte einmalig `supabase/permissions-v2.sql`. Das Skript ist wiederholbar und verändert keine Aufgaben oder Telemetriedaten.

## Feldfrüchte, Symbole und Filter

Die Website enthält den bereitgestellten FS25-Symbolkatalog als browserkompatible PNG-Dateien unter `assets/icons/fs25`. Feldkarten, Ernteübersicht und Finanzkategorien verwenden diese Symbole. Die Feldsuche kann gleichzeitig nach Feldnummer, Frucht oder Besitzer sowie nach Feldfrucht und Status filtern. Frucht- und Statusoptionen werden direkt aus der aktuellen Telemetrie aufgebaut, sodass neue Custom-Map-Früchte automatisch als Filteroption erscheinen. Für noch nicht konvertierbare oder unbekannte Symbole bleibt ein neutrales Pflanzensymbol als Fallback erhalten.

Live-Kartenmarker werden anhand stabiler Feld-, Fahrzeug- und Spieler-IDs aktualisiert. Dadurch bleiben ihre DOM-Elemente zwischen Telemetriepaketen erhalten und blinken nicht mehr bei jedem Update.

Telemetrie-Mod 1.7 überträgt die echten Feldnummern statt der Grundstücksnummern und führt alle Feldquellen einer Custom Map zusammen. Für Hof Bergmann ist zusätzlich der vollständige PDA-Katalog hinterlegt: Feld 1–31, 33–62, 64–70, 74–76 und 78–90. Die auf dieser Karte nicht vorhandenen Nummern 32, 63, 71–73 und 77 werden bewusst nicht erfunden. Der Mod sendet außerdem den vollständigen Fruchttyp-Katalog der gerade geladenen Map inklusive Custom Crops und ihrer lokalisierten Namen. Fahrzeuge und Spieler werden ebenfalls gegen die echten Feldnummern aufgelöst.

## Finanzen und spätere FS25-Telemetrie

Der Bereich **Finanzen** ist unter `/finances` für jeden freigeschalteten Nutzer erreichbar. Er enthält eine kompakte Übersicht für Kontostand, Einnahmen, Ausgaben und Ergebnis sowie ein detailliertes Buchungsjournal. Kategorien wie Fahrzeugkauf, Auftanken, Wartung und Ernteverkauf sind bereits vorbereitet.

Solange noch keine FS25-Telemetrie angeschlossen ist, bleiben alle Finanzwerte und Listen bewusst leer. Auch Felder, Maschinen, Erntefortschritt und Arbeitsaufträge aus dem Spiel werden nicht mit Platzhalterdaten befüllt. Manuell angelegte Website-Aufgaben bleiben davon unberührt und werden weiterhin in Supabase gespeichert.

Führe nach diesem Update ausschließlich `supabase/schema.sql` vollständig im Supabase SQL Editor aus. Das Skript ist wiederholbar, aktualisiert auch ältere Tabellenstrukturen und legt fehlende Tabellen oder Spalten an. Echte Nutzer und Aufgaben bleiben erhalten; ausschließlich die früher fest eingebauten Demo-Aufgaben ohne Ersteller werden entfernt.

Das SQL-Skript legt außerdem `website_sessions` an. Dadurch bleibt die Discord-Anmeldung bei einem Seiten-Refresh sowie nach einem Server-Neustart oder neuen Deployment bestehen. Die Sitzung läuft nach sieben Tagen ab oder wird durch **Abmelden** sofort gelöscht.

## FS25-Live-Telemetrie einrichten

Die Integration besteht aus dem Ingame-Mod `FS25_CompanionTelemetry.zip` und der lokalen Telemetrie-Bridge. FS25-Mods können aus der Lua-Sandbox keine beliebigen sicheren POST-Anfragen an externe Websites senden. Der Mod exportiert deshalb alle zehn Sekunden Felder, Frucht und Wachstumsstand, eigene Fahrzeuge, deren Status, Farmkonto und Finanzereignisse lokal. Die Bridge überträgt diese Datei mit einem eigenen, widerrufbaren Token an die Website.

1. Diese Website-Version deployen und `supabase/schema.sql` ausführen.
2. `FS25_CompanionTelemetry.zip` unverändert in `Documents/My Games/FarmingSimulator2025/mods` kopieren.
3. Den Mod beim Laden des gewünschten Spielstands aktivieren.
4. Im Website-Adminbereich **Kopplungscode erzeugen** anklicken.
5. Die Telemetrie-Bridge entpacken und `Bridge starten.bat` öffnen.
6. Den achtstelligen Code eingeben. Die Bridge verwendet automatisch `https://fs25-companion.onrender.com`. Das Bridge-Fenster während des Spiels geöffnet lassen.

Nur der Host beziehungsweise Dedicated Server exportiert Daten. Multiplayer-Clients erzeugen keine konkurrierenden Telemetriedateien. Auf der Website aktualisieren sich Dashboard und Finanzen danach automatisch über die bestehende Live-Verbindung.

## Sicherheitsdetails

- `DISCORD_CLIENT_SECRET` bleibt auf dem Server.
- `SUPABASE_SECRET_KEY` bleibt auf dem Server.
- Session ist ein signiertes HttpOnly-Cookie; es wird kein Discord Access Token im Browser-LocalStorage gespeichert.
- OAuth-`state` wird geprüft.
- Admin-Endpunkte prüfen die feste Admin-Discord-ID serverseitig.
- Der Admin kann sich selbst nicht auf `blocked` setzen.

### Wichtig für den späteren Live-Spielstand

Die sichtbaren Mock-Daten wurden entfernt. Sobald echte FS25-Save-/Telemetry-Daten angebunden werden, sollten sie über geschützte `/api/...`-Endpunkte kommen und serverseitig gegen Session und Freigabestatus geprüft werden. Die Finanz-Tabelle und die getrennte Browser-/Backend-Struktur sind dafür bereits vorbereitet.
