# Chromecast

Aus dem Player kann ein Film oder eine Folge per Chromecast (und Geräte mit eingebautem Chromecast, z. B. Google TV) auf den Fernseher gesendet werden. Verwendet wird der **Default Media Receiver** von Google: keine Registrierung, keine eigene Receiver-App, kein Google-Konto nötig.

## Voraussetzungen

- `PUBLIC_URL` beginnt mit `https://` und hat ein **öffentlich gültiges Zertifikat** (Let's Encrypt über NPM genügt). Der Chromecast lädt die Streams selbst von dieser Adresse; ein selbst signiertes Zertifikat oder eine reine LAN-Adresse funktioniert nicht.
- Der Chromecast erreicht `PUBLIC_URL` aus seinem Netz (bei Split-DNS muss der Name im Heimnetz auflösen).
- NPM: die Location `/media/c/` aus `deploy/npm/portal.advanced.conf` (mit `access_log off` **und** `error_log /dev/null`, denn auch nginx-Fehlerzeilen enthalten die Anfrage-URI, also das Token) ist eingetragen.
- Absender: Chrome, Edge oder ein anderer Chromium-Browser (Desktop und Android). Safari, Firefox und iOS-Browser bieten keine Cast-Taste (Apple erlaubt dort kein Google Cast); am iPhone hilft AirPlay.
- **Plan B** (nginx `auth_request`, `deploy/npm/plan-b-auth-request.conf`) unterstützt Cast nicht: dort ist `CAST_ENABLED=false` zu setzen.

`CAST_ENABLED=false` schaltet alles ab; die Cast-Taste erscheint dann nicht und das Google-Skript wird nicht geladen.

## Ablauf

1. Beim ersten Öffnen eines Players (nicht im TV-Modus und nicht in der Watch-Party) fragt das Frontend `GET /api/cast/config`. Ist Cast aktiv, wird das Google-Sender-SDK (`https://www.gstatic.com/cv/js/sender/v1/cast_sender.js`) nachgeladen. Dafür enthält die CSP `script-src` zusätzlich die pfadbeschränkten Quellen `https://www.gstatic.com/cv/js/sender/` und `https://www.gstatic.com/cast/sdk/libs/` (nicht den ganzen Host).
2. Ein Klick auf die Cast-Taste öffnet die Geräteauswahl des Browsers. Danach stoppt die lokale Wiedergabe (inkl. Stopp-Meldung an Jellyfin), `POST /api/cast/session` liefert eine Cast-URL und der Chromecast lädt sie.
3. Während der Übertragung steuern alle Player-Elemente (Pause, Springen, Lautstärke, Untertitel, Audiospur, Qualität) den Fernseher. Fortschritt und „Weiterschauen“ laufen über dieselben `/api/playback/*`-Aufrufe wie lokal, mit `playMethod: Transcode`.
4. Beim Beenden oder Verbindungsabbruch wird das Token widerrufen und die lokale Wiedergabe setzt an der letzten Position fort. Am Filmende wird die Sitzung beendet und die „Nächste Folge“-Logik der Seite greift (der Fernseher bleibt nicht automatisch verbunden).

## Das Cast-Token

Der Receiver kann weder Cookies noch eigene Header senden. Deshalb steht ein **Cast-Token** im Pfad: `https://portal.example.com/media/c/<token>/Videos/<id>/master.m3u8?…`. Jellyfin liefert in Playlists relative URIs, daher erben alle Segmente und Untertitel den Pfad.

Eigenschaften:

- 256 Bit zufällig (43 Zeichen, base64url), nur beim Anlegen sichtbar. In Redis liegt ausschließlich `sha256(token)` (`cast:<hash>`, Index `castidx:<userId>:<castId>`); ein Redis-Dump enthält keine nutzbaren Tokens.
- **Scope**: genau ein Titel (`itemId`), eine Medienquelle, eine PlaySession, ein Profil, ein genehmigtes Gerät. Das Gateway lehnt jeden Pfad mit anderer Item-/MediaSource-ID sowie abweichende `MediaSourceId`/`PlaySessionId`-Parameter mit 403 ab.
- **Nur HLS**: erlaubt sind Playlists, Segmente, WebVTT-Untertitel und Poster/Hintergrund des Titels. `/stream` (Direktdownload), Trickplay, Logos und alles andere sind gesperrt.
- **Adress-Bindung**: Das Token gehört der ersten Client-Adresse, die es erfolgreich nutzt (das Gateway reicht `X-Real-IP` bzw. den letzten `X-Forwarded-For`-Eintrag an `/internal/authz` weiter, das Backend speichert sie atomar als `castpin:<hash>`). Jede andere Adresse bekommt 401, ein abgegriffenes Token ist also von woanders nutzlos.
- **Poster-Token**: Die `imageUrl` trägt ein eigenes, nur für Bilder gültiges Token (`kind: img`, nur Primary/Backdrop des Titels; das Gateway lehnt damit jeden Medienpfad mit 403 ab). Es teilt Bindung und Laufzeit mit dem Medien-Token und wird mit ihm widerrufen; Medien-Tokens dürfen auch Bilder laden. Auf die Obergrenze von 2 Tokens zählen nur Medien-Tokens.
- Laufzeit: gleitend 45 Minuten Leerlauf (wird bei jeder erfolgreichen Prüfung, höchstens alle 20 s, verlängert), absolute Obergrenze = Restlaufzeit des Titels + 1 h, mindestens 1 h, höchstens 6 h. Jede erfolgreiche Prüfung hält zudem den Live-Eintrag der PlaySession am Leben, damit `maxStreams` auch dann zählt, wenn kein Absender Fortschritt meldet. Der Player erneuert das Token automatisch kurz vor Ablauf (neues Token, `LOAD` an derselben Stelle).
- Höchstens **2 aktive Tokens pro Konto**; das älteste wird beim Anlegen eines dritten widerrufen. Zusätzlich gilt die Rollengrenze `maxStreams`, die Auflösungs-/Bitrate-Grenze der Rolle (Cast zusätzlich höchstens 1080p und 20 Mbit/s) und `transcoding` der Rolle (ohne Transcoding ist Cast gesperrt).
- Widerruf: `DELETE /api/cast/session/:castId`, beim Beenden des Players, beim Entfernen/Sperren eines Geräts, bei „Andere Sitzungen abmelden“ und beim Deaktivieren des Kontos (`revokeSessions`). Bei **jeder** Anfrage (Gateway-Cache 5 s) prüft das Backend erneut: Token vorhanden und nicht abgelaufen, Konto nicht deaktiviert, Rolle bekannt, Profil gehört noch zum Konto, Absender-Gerät noch genehmigt.
- Das Token gelangt nie zu Jellyfin (das Gateway entfernt den Pfadanteil und setzt den Jellyfin-Token des Profils als Header), nie in Backend-Logs, Metriklabels oder Fehlermeldungen. NPM schreibt für `/media/c/` kein Access-Log (`access_log off`); eigene Log-Pipelines davor sollten die Pfade `/media/c/*` ebenfalls auslassen. Playlists werden im Gateway bereinigt: `api_key`/`ApiKey`-Parameter werden entfernt, jede URI, die aufgelöst nicht unter `/media/c/<token>/` desselben Hosts liegt (absolut, `//host`, `/pfad`, Backslashes), führt zu 502. Playlists dürfen bis 8 MB groß sein. Abfrageparameter `LiveStreamId` und `DeviceId` werden entfernt, `MaxHeight`/`Height` (und `MaxWidth`/`Width` als 16:9-Äquivalent) auf die Auflösungsgrenze des Tokens begrenzt.
- Antworten auf `/media/c/` sind `Cache-Control: no-store`.

## Gateway-Verhalten (`/media/c/<token>/…`)

| Thema | Verhalten |
|---|---|
| Authentifizierung | `POST /internal/authz {ct, client}` (nur mit `X-Internal-Secret`); Cookies werden auf diesem Pfad ignoriert |
| CORS | nur hier: `Access-Control-Allow-Origin: *`, `Expose-Headers: Content-Length, Content-Range, Accept-Ranges`, `OPTIONS` → 204 mit `Allow-Methods: GET, HEAD, OPTIONS`, `Allow-Headers: Range, Content-Type`, `Max-Age: 600`; keine Credentials. Der Cookie-Pfad `/media/…` bleibt ohne CORS |
| Fehlversuche | mehr als 30 **verschiedene** fehlgeschlagene Tokens pro Minute und Client-Adresse (dasselbe widerrufene Token wiederholt zählt einmal) (`X-Real-IP`, sonst letzter `X-Forwarded-For`-Eintrag) → 429 für 5 Minuten |
| Backend nicht erreichbar | 503 (zählt nicht als Fehlversuch) |
| Metriken | `friendflix_gateway_cast_requests_total{code}`; das Token taucht nirgends auf |

## Auf echter Hardware prüfen

Die Tests decken Backend und Gateway ab; folgendes lässt sich nur mit einem Chromecast prüfen:

- Cast-Taste erscheint nur in Chromium, Geräteauswahl, Start an der gemerkten Position, Pause/Springen/Lautstärke, Untertitel an/aus und Wechsel der Audiospur.
- HLS/TS-Wiedergabe von Quellen mit HEVC, 10 Bit, H.264 Level über 4.1, 5.1-Ton und 4K (Jellyfin muss transkodieren; der Default Media Receiver verlangt H.264 bis Level 4.1 und AAC).
- Die pfadbeschränkten CSP-Ausnahmen für `www.gstatic.com` (`/cv/js/sender/`, `/cast/sdk/libs/`) reichen für das SDK; lädt es weitere Skripte von anderen Pfaden (oder braucht `connect-src`/`frame-src`), nur genau diese ergänzen.
- Der Chromecast nutzt für Playlist, Segmente und Poster dieselbe Client-Adresse (Adress-Bindung; z. B. kein Wechsel zwischen IPv4/IPv6 im laufenden Betrieb).
- Token-Erneuerung bei langen Titeln und das Zurückwechseln auf lokale Wiedergabe nach Verbindungsabbruch.
- Verhalten hinter Split-DNS/NAT-Loopback und mit dem NPM-Zertifikat.
