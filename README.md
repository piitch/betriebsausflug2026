# 🥌 Eisstock-Rangliste – Eurofun Touristik Betriebsausflug 2026

Web-App fürs Handy: Spielplan, Ergebniserfassung pro Kehre, Rangliste **und Literwertung** 🍺.
Läuft kostenlos auf **GitHub Pages**, die Daten liegen in einer kostenlosen **Supabase**-Datenbank.
Alle Handys sehen dieselben Daten, live (Aktualisierung alle 4 Sekunden).

- **Anschauen** kann jeder mit dem Link.
- **Eintragen** (Ergebnisse, Liter, Setup) geht nur mit der **Schreib-PIN**. Die PIN wird in der Datenbank geprüft, nicht im Browser.

## Wie wird gewertet?

| | |
|---|---|
| **Spielmodus** | Jeder gegen Jeden. Die App erstellt den Spielplan mit Runden und Bahnen. |
| **Kehre** | Nur die Mannschaft mit dem Stock **am nächsten an der Daube** punktet: **3 Punkte** für diesen Stock, **+2** für jeden weiteren eigenen Stock, der näher liegt als der beste gegnerische (1/2/3/4 Stöcke = 3/5/7/9 Punkte). |
| **Spiel** | 6 Kehren (einstellbar). Die Stockpunkte werden addiert: **Sieg 2**, **Unentschieden 1**, **Niederlage 0** Spielpunkte. |
| **Sportwertung** | 1. Spielpunkte → 2. **Stocknote** (erzielte ÷ erhaltene Stockpunkte, wie bei offiziellen Turnieren) → 3. Differenz → 4. erzielte Stockpunkte |
| **Literwertung** | Getränke per Knopf (+0,3 / +0,5 / +1,0 l oder eigene Menge) pro Person. Mannschaften nach Gesamtlitern, bei Gleichstand nach Ø pro Kopf. Dazu eine Einzelwertung. |
| **Gesamtwertung** | Platz Sport + Platz Liter. Die kleinste Summe gewinnt, bei Gleichstand der bessere Sportplatz. |

Am Handy wird pro Kehre nur getippt: *welche Mannschaft* → *wie viele Stöcke*. Die Punkte rechnet die App.

## Einrichtung (ca. 15 Minuten, einmalig)

### 1. Supabase-Datenbank anlegen

1. Auf [supabase.com](https://supabase.com) kostenlos registrieren → **New project** (Region z. B. Frankfurt).
2. Links **SQL Editor** öffnen. Den kompletten Inhalt von [`supabase/setup.sql`](supabase/setup.sql) einfügen.
3. **Ganz oben die PIN ändern** (`'bitte-aendern'` → eure PIN, am besten 6 Zeichen oder mehr) → **Run**.
4. Unter **Project Settings → API** (bzw. *API Keys*) notieren:
   - **Project URL**, z. B. `https://abcdefgh.supabase.co`
   - **Publishable key** bzw. **anon public key**. Dieser Schlüssel darf öffentlich sein, weil Schreiben nur mit PIN geht.

> PIN später ändern: In `setup.sql` die PIN anpassen und erneut ausführen. Vorhandene Daten bleiben erhalten.

### 2. GitHub Pages aktivieren

1. Im Repository: **Settings → Secrets and variables → Actions → Tab „Variables“** → **New repository variable**:
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_KEY` = publishable/anon key
2. **Settings → Pages → Source: „GitHub Actions“**.
3. Auf den Standard-Branch pushen, dann startet das Deployment automatisch. Alternativ unter **Actions → Deploy GitHub Pages → Run workflow** starten.
4. Die App läuft dann unter `https://<user>.github.io/<repo>/`.

> GitHub Pages ist bei **privaten** Repositories nur mit einem bezahlten GitHub-Plan verfügbar. Bei einem öffentlichen Repository ist es kostenlos. Im Code stehen keine Geheimnisse.

### 3. Am Tag selbst

1. Link (am besten als QR-Code) an alle verteilen. Am Handy über *Teilen → Zum Home-Bildschirm* wie eine App nutzen.
2. **Setup** → PIN eingeben → Mannschaften und Mitspieler anlegen → **Spielplan erstellen**.
3. Pro Bahn trägt eine Person mit PIN die Kehren ein → **Spiel beenden & werten**.
4. Die Liter trägt, wer die PIN hat, unter **Liter** ein. Ein Tippfehler lässt sich über „Rückgängig“ oder „Löschen“ korrigieren.
5. Die Rangliste kann parallel auf einem Beamer oder Fernseher laufen.

⚠️ **Supabase pausiert kostenlose Projekte nach 7 Tagen ohne Zugriff.** Ein paar Tage vorher die App einmal öffnen oder das Projekt im Supabase-Dashboard mit „Restore“ wieder aufwecken.

## Ohne Datenbank (Notlösung)

Ohne Supabase-Variablen läuft die App im **lokalen Modus**: Alle Daten liegen nur auf diesem einen Gerät. Das reicht, wenn eine Person alles einträgt.
Unter *Setup → Verbindung* lässt sich eine Supabase-Verbindung auch direkt am Gerät eintragen, z. B. zum Testen.

## Entwicklung

```bash
npm test          # Tests für Wertung und Spielplan
npm start         # lokaler Server für ./public (lokaler Modus)
```

Aufbau: reines HTML/CSS/JS ohne Build-Schritt.

| Datei | Inhalt |
|---|---|
| `public/js/scoring.js` | Wertung (Kehren, Sport, Liter, Gesamt) |
| `public/js/schedule.js` | Spielplan Jeder gegen Jeden |
| `public/js/backend.js` | Datenzugriff (Supabase-REST oder lokal) |
| `public/js/app.js` | Oberfläche |
| `supabase/setup.sql` | Tabellen, Leserechte, PIN-geschützte Schreibfunktionen |
| `.github/workflows/pages.yml` | Tests + Deployment auf GitHub Pages |
