# Offline-Downloads

Mitglieder mit der Rolle-Berechtigung „Downloads erlauben“ können Filme und Folgen auf ein Gerät laden und dort ohne Verbindung ansehen (Menü → Downloads).

## So funktioniert es

1. **Lizenz:** Der Knopf „Herunterladen“ legt pro Gerät eine Lizenz an (Rolle, `Max. Downloads` pro Konto, Qualität maximal `Max. Download-Qualität`). Bei Serien lassen sich die nächsten Folgen (bis 10) in einem Schritt laden. Lizenzen gehören zu einem **Profil**: Jedes Profil sieht, lädt, löscht und synchronisiert nur seine eigenen (derselbe Titel kann in zwei Profilen getrennt geladen werden); das Kontingent `Max. Downloads` zählt pro Konto. Das Anlegen wartet nicht auf die Vorbereitung: Jobs und Lizenzen werden in einer Transaktion eingetragen (alles oder nichts), die Vorbereitung übernimmt der Hintergrund-Takt. Eine Datei hängt zusätzlich an der wirksamen Höhen-/Bitratengrenze der Rolle, Rollen mit unterschiedlichen Grenzen teilen sich keine Datei.
2. **Vorbereitung auf dem Server:** Das Backend holt den Titel als HLS (fMP4) von Jellyfin, setzt ihn mit `ffmpeg -c copy -movflags +faststart` zu einer normalen MP4-Datei zusammen und legt sie unter `DOWNLOAD_DIR` ab. Die Vorbereitung ist wiederaufnehmbar und pausiert, solange mindestens `DOWNLOAD_PAUSE_STREAMS` Streams laufen. Der Fortschritt erscheint als „Wird vorbereitet · 34 %“, danach kommt eine Push-Nachricht „Download bereit“. Passt die Quelle ohne Umwandlung (MP4, 8-Bit H.264, AAC/MP3, innerhalb der Rollenlimits), wird „Original“ direkt von Jellyfin durchgereicht.
3. **Übertragung:** Der Browser lädt die Datei über `/media/d/<id>` (Cookie-Login, Range/Wiederaufnahme) in den Origin Private File System (OPFS) des Browsers. Der Tab muss dafür offen bleiben.
4. **Offline ansehen:** `/offline` listet die Downloads des zuletzt benutzten Profils (bei jedem Profilwechsel und App-Start gemerkt). Offline zeigt das Gerät also immer die Downloads des zuletzt aktiven Profils; Downloads anderer Profile bleiben gespeichert, werden aber erst nach dem Wechsel online angezeigt, geprüft und synchronisiert. Die Wiedergabe liest die Datei lokal; Position und „gesehen“ werden gespeichert und bei der nächsten Verbindung mit Jellyfin abgeglichen (neuere Jellyfin-Stände gewinnen).
5. **Prüfung:** Online prüft die App Lizenzen beim Start und bei Wiederverbindung. Gültigkeit = `Gültigkeit (Tage)` der Rolle, offline höchstens `DOWNLOAD_OFFLINE_GRACE_DAYS` (7) ab der letzten Prüfung. Widerrufene Lizenzen (Gerät gelöscht/gesperrt, Konto deaktiviert, Rolle ohne Downloads, Admin-Widerruf) löscht das Gerät bei der nächsten Prüfung. Die Uhr wird gegen Zurückdrehen geprüft.

Abmelden fragt, ob die Downloads dieses Geräts gelöscht werden sollen (Standard: ja). Behaltene Downloads bleiben nach dem Abmelden abspielbar, bis ihre Gültigkeit (`validUntil`) endet; danach braucht es eine Anmeldung und Online-Prüfung. Ein Ablauf der Sitzung löscht nichts.

## Plattformen

| Plattform | Status |
|---|---|
| Chrome/Edge Desktop, Android (Chrome, installierte PWA) | unterstützt; Tab muss während des Ladens offen bleiben |
| Firefox Desktop/Android (OPFS ab 111) | unterstützt; Speicher ca. 10 GiB nach bestem Bemühen, ggf. Nachfrage „Dauerhaft speichern“ |
| Safari 17+ macOS | unterstützt; Wiedergabe über den Service-Worker-Pfad `/__dl/<id>/video.mp4` |
| iOS/iPadOS 17+ | nur als Home-Bildschirm-App (sonst räumt Safari Website-Daten nach 7 Tagen auf); nur im Vordergrund, Display bleibt per Wake Lock an |
| iOS < 17, TV-Modus, Chromecast | nicht verfügbar, der Knopf ist ausgeblendet („Auf diesem Gerät nicht verfügbar“) |

Voraussetzung: sicherer Kontext (HTTPS), `navigator.storage.getDirectory` und `createSyncAccessHandle`. Hintergrundladen (Background Fetch) ist nicht enthalten.

## Ehrlicher Hinweis zu DRM

Es gibt **keinen Kopierschutz**. Die Datei auf dem Gerät ist ein gewöhnliches, unverschlüsseltes MP4 im Browserspeicher, und auch auf dem Server liegen die vorbereiteten Dateien unverschlüsselt in `DOWNLOAD_DIR`. Ablauf und Widerruf setzt nur die App selbst durch (beim nächsten Online-Check); wer die Daten kopiert oder die App umgeht, ist dadurch nicht aufzuhalten. Downloads sind für vertrauenswürdige Freunde und Familie gedacht, nicht als Schutz gegen Weitergabe. Bildbasierte Untertitel (PGS/VobSub) stehen offline nicht zur Verfügung.

## Betrieb

- Speicher: `DOWNLOAD_CACHE_MAX_GB` (Standard 50) begrenzt die vorbereiteten Dateien, die ältesten ungenutzten fliegen zuerst raus; `DOWNLOAD_FILE_TTL_HOURS` (48) räumt nicht mehr benötigte Dateien auf. Beim Zusammensetzen wird kurzzeitig doppelter Platz gebraucht. Vor dem Start (und Fortsetzen) eines Jobs wird geprüft, ob fertige Dateien + Teildateien + geschätzte Größe (doppelt, wegen des Zusammensetzens) in `DOWNLOAD_CACHE_MAX_GB` passen und das Laufwerk danach mindestens `DOWNLOAD_MIN_FREE_GB` (2) frei behält; sonst werden zuerst ungenutzte fertige Dateien entfernt, und passt es dann immer noch nicht, bleibt der Job in der Warteschlange (Logzeile, nächster Versuch alle 15 s). Eine fertige Datei, die ein Gerät `3 Tage` lang nicht abgeholt hat, ist nicht mehr vor dem Aufräumen geschützt (die Lizenz bleibt bestehen, zeigt dann aber „Vorbereitung fehlgeschlagen“ und lässt sich löschen). Wird die letzte wartende Lizenz eines Jobs gelöscht oder widerrufen, wird der Job abgebrochen (Status „failed“, Fehler `cancelled`); eine laufende Vorbereitung stoppt beim nächsten Segment und räumt ihre Teildatei auf.
- Last: `DOWNLOAD_PREP_CONCURRENCY` (1) Jobs gleichzeitig; Vorschau-Clips pausieren währenddessen. Übersicht und Widerruf unter *Admin → Wiedergabe-Check → Offline-Downloads*.
- Rollen: *Admin → Rollen* (Downloads erlauben, Max. Downloads, Max. Download-Qualität, Gültigkeit in Tagen).
- NPM: keine Änderung nötig, `/media/` deckt `/media/d/` ab. Bei Plan B (`auth_request`) bleibt `/media/d/` in `deploy/npm/plan-b-auth-request.conf` gesperrt bzw. wird wie `/media/` behandelt.

### Speicherort

Ohne weitere Einstellung liegen die vorbereiteten Dateien im Docker-Volume `downloads` und die Vorschau-Clips im Volume `previews`. Für eine eigene Platte (z. B. das große Datenlaufwerk der NAS) setzt man in `.env` einen Host-Ordner:

```bash
mkdir -p /mnt/data/friendflix/downloads /mnt/data/friendflix/previews
chown 1000:1000 /mnt/data/friendflix/downloads /mnt/data/friendflix/previews   # Container laufen als uid 1000 (node)
```

```env
DOWNLOADS_PATH=/mnt/data/friendflix/downloads
PREVIEWS_PATH=/mnt/data/friendflix/previews
```

Das Backend schreibt in den Ordner, das Gateway liest ihn nur (`:ro`). Den Ordner unbedingt vorher anlegen und `chown` setzen: legt Docker ihn selbst an, gehört er root, und das Backend kann nicht hineinschreiben (`EACCES` im Backend-Log). Beim Wechsel des Speicherorts bleiben die alten Dateien im alten Volume liegen; bereits auf Geräten gespeicherte Downloads sind davon nicht betroffen.

Alle Werte in diesem Abschnitt haben Standardwerte in `compose.yaml`/`compose.prod.yaml`; `.env` muss nur setzen, was abweichen soll.

### Plan B: Downloads abschalten

`DOWNLOADS_ENABLED=false` in `.env` und Stack neu starten. Die Funktion verschwindet (Menü, Knöpfe, API); schon geladene Kopien werden bei der nächsten Prüfung widerrufen und gelöscht. Es sind keine Änderungen an NPM nötig.

## Hardware-Testliste (manuell)

- [ ] Chrome Desktop: Film in HD laden, Tab schließen/öffnen, Fortsetzen nach Abbruch (WLAN trennen), Offline-Wiedergabe mit Untertitel.
- [ ] Chrome Android als PWA: laden, Flugmodus, abspielen, Position wird nach Wiederverbindung synchronisiert.
- [ ] Firefox Desktop: laden, abspielen, Persist-Nachfrage.
- [ ] Safari macOS 17+: laden und über `/__dl/…` abspielen, Vorspulen funktioniert (Range).
- [ ] iPhone iOS 17+ (Home-Bildschirm): laden im Vordergrund, Display bleibt an, Flugmodus-Wiedergabe, Spulen. Im Safari-Tab: Hinweis „zum Home-Bildschirm hinzufügen“.
- [ ] iOS < 17 / TV-Modus: Knopf ausgeblendet.
- [ ] Serie: „nächste 3 Folgen“ über Staffelgrenze.
- [ ] Limit `Max. Downloads` erreicht → verständliche Meldung.
- [ ] Gerät löschen / Konto deaktivieren / Admin widerrufen → Kopie verschwindet nach der nächsten Prüfung.
- [ ] Uhr zurückdrehen → Wiedergabe gesperrt bis zur Online-Prüfung.
- [ ] Abmelden: Dialog „Downloads löschen?“ (Standard ja), Speicher danach frei.
- [ ] Server: zwei laufende Streams → Vorbereitung pausiert; Plattenlimit erreicht → älteste Datei wird entfernt.

## Grenzen

- Originalstreams (`/media/Videos/<id>/stream` und `stream.<ext>`, auch mit `static=true`) umgehen den Transcoder und damit Auflösungs- und Bitratenlimit der Rolle. Das Gateway (und bei Plan B `/internal/authz-nginx`) antwortet deshalb mit 403, wenn die Rolle eine **Höhenbegrenzung** hat; die Wiedergabe-Info (`/api/playback/info`) bietet diesen Rollen dann keinen Direct Play an, sie sehen nur HLS.
- Rollen **ohne** Download-Recht, aber ohne Höhenbegrenzung (Standard: „Freund“) behalten Direct Play – sonst müsste der Server für sie jeden Film transkodieren. Über einen Originalstream könnten sie die Datei theoretisch speichern. Wer das ausschließen will, setzt `DIRECT_PLAY_REQUIRES_DOWNLOAD=true`: dann verlieren auch diese Rollen Direct Play (mehr Transcoding-Last auf dem Server).
- Nicht betroffen sind der Cast-Pfad (kennt `/stream` ohnehin nicht) und `/media/d/<id>` (eigene Lizenzprüfung). `/Items/<id>/Download` steht nicht in der Pfad-Allowlist. Restrisiko: Das Bitratenlimit allein sperrt Direct Play nicht (die Quelle wird beim Anbieten gegen das Limit geprüft, das Gateway kennt die Quellbitrate nicht); es gibt keinen Kopierschutz (siehe oben).
- Fehlerdetails von Jellyfin/ffmpeg sehen nur Admins (*Offline-Downloads*-Übersicht) und das Server-Log; Mitglieder sehen „Vorbereitung fehlgeschlagen“.
