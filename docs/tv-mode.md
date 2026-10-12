# Fernseher: TV-Modus + Handy als Fernbedienung

FriendFlix läuft auf jedem Fernseher mit modernem Browser (Android TV / Google TV, Fire TV, Samsung Tizen, LG webOS, Konsolen, Mini-PC am HDMI).
Der Fernseher bekommt eine eigene Oberfläche (große Schrift, Fokusrahmen, Steuerung mit Pfeiltasten) und wird vom Handy aus gesteuert.
Es wird **kein** Cast-/AirPlay-Protokoll benutzt: Das Portal selbst ist die Fernbedienung (WebSocket zwischen Handy und Fernseher desselben Nutzers).

## Einrichten (einmalig pro Fernseher)
1. Auf dem Fernseher im Browser `https://portal.<domain>/tv` öffnen (als Lesezeichen/Startseite speichern). Es erscheinen ein **Code** (`ABCD-EFGH`) und ein QR-Code.
2. Auf dem Handy (eingeloggt): **Menü → Fernbedienung**, Code eingeben, **Koppeln** (oder QR-Code scannen – der Code ist dann schon eingetragen; bestätigt wird trotzdem von Hand).
3. Der Fernseher meldet sich selbst an und öffnet die Startseite im TV-Modus. Er bleibt 30 Tage angemeldet (7 Tage ohne Nutzung) und erscheint unter **Geräte** als „Fernseher (TV-Modus)“.

Abmelden am Fernseher: Profil-Menü → Abmelden (danach wieder Kopplungs-Bildschirm) oder am Handy unter *Geräte* entfernen – das beendet die Sitzung **und** trennt die Verbindung sofort.

## Bedienung am Fernseher
| Taste | Aktion |
|---|---|
| Pfeiltasten | Fokus zur nächsten Kachel/Schaltfläche in dieser Richtung (Reihen blättern automatisch) |
| OK / Enter | öffnen / abspielen |
| Zurück (Back, Esc, Backspace) | eine Ebene zurück; der Fokus springt wieder auf die Kachel, die du verlassen hast |
| Im Player | OK = Pause/Play · ←/→ = ∓/+10 s · ↑/↓ = Steuerleiste öffnen (dann mit den Pfeilen wählen) · Zurück schließt Menü → Leiste → Player |
| Medientasten | Play/Pause, ±30 s (Vor/Zurück-Spulen), nächste Folge |

Startet der Browser die Wiedergabe ohne vorherigen Tastendruck (z. B. wenn das Handy etwas schickt), beginnt sie **stumm** mit Hinweis; die erste Taste schaltet den Ton ein.

## Fernbedienung am Handy
- **Menü → Fernbedienung**: Status (Titel, Position), Play/Pause, ±10 s, ±60 s, Beenden, Startseite, *Weiter schauen* und Titelsuche mit **Auf TV**.
- Auf jeder Detailseite erscheint **Auf Fernseher**, sobald ein Fernseher verbunden ist.
- Es wird immer der Fernseher **desselben Nutzers** gesteuert (nie der anderer Freunde). Pro Nutzer ist ein Fernseher aktiv; ein zweiter ersetzt den ersten.

## Vorschau im Browser
`https://portal.<domain>/?tv=1` zeigt den TV-Modus auf jedem Rechner (nur Optik und Tastatursteuerung, keine Kopplung; `?tv=0` beendet die Vorschau).

## Sicherheit
- Der Code ist 8 Zeichen aus einem 32er-Alphabet (ohne 0/O/1/I), 10 Minuten gültig, einmal verwendbar, nur gehasht mit einem geheimen Abruf-Token des Fernsehers verknüpft; `/api/tv/code` und `/api/tv/pair` sind rate-limitiert.
- Koppeln kann nur ein **eingeloggter** Nutzer (CSRF-Token wie überall). `/api/tv/code` und `/api/tv/claim` sind anonym und deshalb vom CSRF-Check ausgenommen: Sie haben keine Berechtigung außer dem geheimen Token.
- **Phishing-Schutz:** Wer dir einen Code/QR schickt, könnte einen *fremden* Fernseher an dein Konto koppeln wollen. Die Seite warnt davor; außerdem bekommst du bei jeder Kopplung eine Benachrichtigung „Ein Fernseher wurde mit deinem Konto verbunden“ (Link zu *Geräte*) und einen Audit-Log-Eintrag (`tv.pair`, `tv.claim`).
- Die WebSocket-Verbindung (`/ws/remote`) prüft Origin und Session, akzeptiert vom Handy nur eine feste Liste von Befehlen (`cast`, `play`, `pause`, `toggle`, `seekBy`, `stop`, `home`) und vom Fernseher nur Statusmeldungen; mit Flood-Limit.
- Gerät entfernen, „Überall abmelden“ oder Nutzer sperren beendet Fernseher-Sitzung und -Verbindung sofort.

## Technik / Grenzen
- Der Fernseher spielt wie jeder andere Client über das Gateway (Direct Play oder HLS via hls.js); es läuft nichts am Gateway vorbei.
- Getestet mit Chromium (automatisiert, inkl. Autoplay-Sperre und Fokus-Navigation). Auf echten Fernsehern bitte ausprobieren: Back-Tasten sind für Tizen (10009), webOS (461), Android/Fire TV (4) vorbereitet; ältere Fernseher-Browser ohne Media Source Extensions können nicht abspielen.
- Watch-Party ist am Fernseher nicht vorgesehen (Chat braucht eine Tastatur).
- NPM braucht für `/ws/` „Websockets Support“ (siehe `deploy/npm/portal.advanced.conf`), sonst bleibt die Fernbedienung offline.

## Fehlersuche
| Symptom | Ursache |
|---|---|
| Handy zeigt „Kein Fernseher verbunden“, TV läuft | WebSocket kommt nicht durch NPM (Websockets Support, `Origin`), oder `PUBLIC_URL` stimmt nicht mit der aufgerufenen Adresse überein |
| „Code unbekannt oder abgelaufen“ | Code älter als 10 Minuten; am Fernseher erscheint automatisch ein neuer |
| Fernseher springt nach Tagen auf den Kopplungs-Bildschirm | Sitzung abgelaufen (7 Tage ungenutzt) oder Gerät unter *Geräte* entfernt |
| Bild, aber kein Ton | Autoplay-Sperre: eine Taste drücken |
