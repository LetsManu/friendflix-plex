# Betrieb: Backup, Restore, Firewall, Updates, Image-Prüfung

Erstinstallation: [de/setup.md](de/setup.md) ([English](setup.md)). Authentik einrichten, sichern und aktualisieren: [de/authentik.md](de/authentik.md) ([English](authentik.md)).

> **FriendFlix for Plex (Preview):** Backups, Restore, Firewall und Updates gelten unverändert. Jellyfin-spezifische Teile (Jellyfin-Health-Check, „Plan B“) entfallen bzw. werden mit Plex **nicht unterstützt**; die Plex-Einrichtung steht in [de/plex.md](de/plex.md).

## Backups & Wiederherstellung
**Aktivieren** (opt-in, Compose-Profil `backup`; gilt für `compose.yaml` und `compose.prod.yaml`):
```bash
mkdir -p backups && chown 70 backups          # Container läuft als postgres-User (uid 70)
docker compose --profile backup up -d backup  # bzw. -f compose.yaml -f compose.prod.yaml --profile backup ...
docker compose logs -f backup                 # eine Zeile pro Lauf: "backup: OK <datei> (<bytes>), kept N dumps" oder "FAIL exit=<rc>"
```
- Der Sidecar nutzt `postgres:17-alpine` (gleiche Major-Version wie `postgres`; beim Upgrade beide gemeinsam anheben) und läuft täglich um `BACKUP_HOUR` (Default 3, Zeitzone aus `TZ`). Optional `BACKUP_RUN_ON_START=true` für einen Sofort-Dump beim Start.
- **Ablauf je Lauf:** `pg_dump -Fc` in eine `.tmp`-Datei, Prüfung mit `pg_restore --list`, erst dann Umbenennen nach `friendflix-YYYYmmdd-HHMM.dump`; danach werden Dumps älter als `BACKUP_KEEP_DAYS` (Default 14) gelöscht. Schlägt ein Schritt fehl, bleibt der letzte gute Dump unangetastet, die Logzeile zeigt `FAIL exit=<rc>` und der Container wird `unhealthy` (`docker compose ps`; für Alarme z. B. Portainer/Icinga auf den Health-Status).
- **Ablageort:** Host-Verzeichnis `BACKUP_PATH` (Default `./backups`) → `/backups` im Container. Das Passwort liest der Sidecar aus dem Volume `bootstrap` (`/run/friendflix/postgres_password`, schreibgeschützt eingebunden); ein gesetztes `POSTGRES_PASSWORD` hat Vorrang, `BACKUP_PGPASSWORD_FILE` wählt eine andere Datei. Nie aus dem Image oder dem Dump-Verzeichnis.
- Alternativ per Cron auf dem Host: `0 3 * * * cd /opt/friendflix && ./scripts/backup.sh >> backups/backup.log 2>&1`
- **Off-site:** Dumps zusätzlich auf ein anderes Gerät kopieren, ein Backup auf derselben Platte schützt nicht vor Plattenausfall. Beispiel TerraMaster-NAS: `BACKUP_PATH` auf ein NAS-Share legen (NFS/SMB) und dort Snapshots aktivieren, oder per Cron `rsync -a --delete-after backups/ nas:/volume1/backups/friendflix/`. Das Volume `bootstrap` separat sichern (siehe unten).

**Backup = Datenbank-Dump + Volume `bootstrap`.** Das Volume enthält die erzeugten Secrets (Passwörter für Datenbank und Redis, `APP_ENC_KEY`, `INTERNAL_SECRET`). Der nächtliche Sidecar nimmt es bewusst **nicht** mit: Der Schlüssel neben den Daten, die er schützt, hebt die Trennung auf. Einmal nach der Installation und nach jeder Änderung eines dieser Werte sichern:
```bash
./scripts/backup-bootstrap.sh     # -> backups/friendflix-bootstrap-<UTC-Zeit>.tgz (Modus 0600, gehört dem Aufrufer)
```
Die Datei getrennt von den Dumps aufbewahren (Passwort-Manager als Anhang, anderes Gerät). Andere Projektnamen: `COMPOSE_PROJECT_NAME=<name> ./scripts/backup-bootstrap.sh`; Zielordner `BACKUP_DIR`. Mit `compose.secrets.yaml` kommen `APP_ENC_KEY` und `INTERNAL_SECRET` aus `secrets/`; dann zusätzlich diesen Ordner sichern. Das Volume `bootstrap-gateway` braucht kein Backup (der Dienst `bootstrap` füllt es bei jedem Start neu).

**Wiederherstellung** (App gestoppt, damit keine Verbindungen offen sind):
```bash
docker compose stop backend gateway
docker compose exec -T postgres pg_restore --clean --if-exists --no-owner -U friendflix -d friendflix < backups/friendflix-<ts>.dump
docker compose start backend gateway
```
Bei einer leeren/neuen Datenbank (neuer Host) **zuerst das Volume `bootstrap` zurückspielen**, dann den Stack mit `postgres` starten (`docker compose up -d postgres`) und wie oben einspielen. Migrationen laufen beim Start des Backends ggf. nach.
```bash
docker volume create friendflix_bootstrap   # leer, vor dem ersten `docker compose up`
docker run --rm -v friendflix_bootstrap:/s -v "$PWD/backups":/b:ro alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 tar xzf /b/friendflix-bootstrap-<zeit>.tgz -C /s
```
Das Image ist wie in `scripts/backup-bootstrap.sh` per Digest gepinnt (es läuft als root auf dem Secrets-Volume); beim Anheben Tag und Digest dort und hier gemeinsam ändern.

**Ohne das Volume** erzeugt der Dienst `bootstrap` einen neuen `APP_ENC_KEY`: Die geheimen Einstellungen in der Datenbank sind dann unlesbar (*Admin → Einstellungen* zeigt *Gespeicherter Wert nicht lesbar*, das Backend loggt die Namen), sie müssen neu eingegeben werden; die gespeicherten Jellyfin-Passwörter der Nutzer gehen verloren. Ist nur der alte `APP_ENC_KEY` bekannt (Passwort-Manager, alte `.env`), ihn vor dem ersten Start als `APP_ENC_KEY` in die `.env` setzen: Der Dienst `bootstrap` übernimmt ihn ins Volume. **Volume weg, aber `pgdata` noch da** (gleicher Host, nur das Volume `bootstrap` gelöscht): Der neue `postgres_password` passt nicht zur bestehenden Datenbank (Postgres liest `POSTGRES_PASSWORD_FILE` nur beim ersten Anlegen), das Backend kommt nicht hinein. Deshalb vor dem ersten `docker compose up` den alten `POSTGRES_PASSWORD` **und** den alten `APP_ENC_KEY` in die `.env` setzen; der Dienst `bootstrap` übernimmt beide ins Volume. Ist das alte Postgres-Passwort unbekannt, es in Postgres neu setzen (`docker compose exec postgres psql -U friendflix -c "\password friendflix"`) und denselben Wert als `POSTGRES_PASSWORD` eintragen.

**Restore-Test** (monatlich per Cron, Exit-Code ≠ 0 bei Fehler → Icinga/Cron-Mail): `./scripts/restore-test.sh`
Startet einen Wegwerf-Postgres ohne Port-Mapping, spielt den neuesten Dump ein und prüft Migrationen und Tabellen. Schnellprüfung einer einzelnen Datei: `docker compose exec -T postgres pg_restore --list < backups/<datei>.dump | head`.

- **Volume `bootstrap` sichern!** (getrennt vom Dump). Ohne den `APP_ENC_KEY` darin sind die gespeicherten Jellyfin-Passwörter der Nutzer und die geheimen Einstellungen unlesbar.
- Nicht im Dump: Daten von Jellyfin, Wunsch-Dienst und Authentik (eigene Backups dieser Dienste; Authentik: [de/authentik.md §2.6](de/authentik.md#26-backups-und-updates)).

## TMDB-/OMDb-Schlüssel wechseln
Die optionalen Schlüssel für die Detailseite lassen sich ohne Neustart tauschen:
- **Über das Portal:** *Admin → Datenquellen*, neuen Schlüssel eintragen, *Testen*, *Speichern*. Die Sperre nach einem abgelehnten Schlüssel (401, 1 Stunde) und die zwischengespeicherten Fehlantworten fallen sofort weg.
- **Über die Secret-Datei** (`TMDB_API_KEY_FILE` / `OMDB_API_KEY_FILE`): Datei ändern und das Backend neu starten: `docker compose restart backend` (mit denselben `-f`-Dateien wie beim Start, z. B. `docker compose -f compose.prod.yaml -f compose.secrets.yaml restart backend`). `up -d` erstellt den Container nicht neu, wenn sich nur der Inhalt der Datei geändert hat. Beim Start erkennt das Backend den geänderten Schlüssel und hebt die Sperre und die zwischengespeicherten Fehlantworten sofort auf; ein erfolgreicher *Testen*-Klick tut das ebenfalls. Ein Schlüssel aus Datei oder Umgebung hat Vorrang vor einem im Portal gespeicherten; die Admin-Seite zeigt ihn dann nur an. Zum Wechsel auf die Portal-Eingabe die Variable entfernen.
- Der im Portal gespeicherte Schlüssel ist mit `APP_ENC_KEY` verschlüsselt und steht wie alle Einstellungen in der Tabelle `settings` (auch unter *Admin → Einstellungen → Datenquellen*). Geht `APP_ENC_KEY` verloren, meldet die Seite den Schlüssel als ungültig; dann einfach neu eintragen.

## Host-Firewall (zusätzlich zum fehlenden Port-Mapping)
Jellyfin und der Wunsch-Dienst haben keine `ports:` und hängen nur im internen Netz. Falls sie auf dem Host zusätzlich laufen (nicht gebündelt):
```bash
# Docker umgeht ufw: Regeln gehören in DOCKER-USER
iptables -I DOCKER-USER -p tcp -m multiport --dports 8096,8920,5055 ! -s 127.0.0.1 -j DROP
ufw deny 8096,8920,5055/tcp
```
Prüfung von außen: `nmap -p 8096,8920,5055 <öffentliche-IP>` → alle `filtered/closed`.

## Updates
Produktions-Stack (`compose.prod.yaml`): `docker compose -f compose.prod.yaml -f compose.plex.yaml pull && docker compose -f compose.prod.yaml -f compose.plex.yaml up -d`; die `.env` bleibt unverändert gültig. Selbst gebauter Stack (`compose.yaml`): `git pull && docker compose build --pull && docker compose up -d`. Migrationen laufen beim Start (Advisory-Lock, transaktional). Umstieg einer älteren Installation auf Einstellungen in der Datenbank und das Volume `bootstrap`: [de/setup.md §14](de/setup.md#14-umstieg-auf-einstellungen-in-der-datenbank).
Nach Jellyfin-Updates: `JELLYFIN_URL=… ./scripts/gen-jellyfin-client.sh` und Diff prüfen (Pfade ändern sich zwischen Versionen; der Client probiert alte/neue Pfade für Views/Resume/Item/Favoriten/Gesehen).

## Updates aus dem Portal
*Admin → Update* vergleicht die installierte Version (`APP_VERSION`/`APP_CODENAME` aus `version.json` und `GIT_SHA`, beim Image-Build eingebacken) je nach [Release-Kanal](#release-kanäle) mit dem neuesten GitHub-Release von `UPDATE_REPO` (Stabil: *Update verfügbar*, Notizen unter *Was ist neu*) oder mit dem letzten erfolgreichen CI-Lauf auf `main` (Nightly: wie viele Commits er weiter ist; auf Stabil Zusatzinfo und vor dem ersten Release der einzige Vergleich). Das Portainer-Stack lässt sich sofort neu ziehen. Portainer selbst zieht Images ohnehin alle 12 Stunden. Der Knopf bleibt deaktiviert, solange eine der beiden Varianten fehlt:

- **Webhook (einfach):** In Portainer → Stacks → *dein Stack* → *Stack-Webhook* aktivieren, URL kopieren und als `PORTAINER_WEBHOOK_URL` setzen. Die URL enthält ein Token und ist ein Secret (auch als `PORTAINER_WEBHOOK_URL_FILE` möglich).
- **API:** In Portainer → *My account* → *Access tokens* ein Token anlegen (`PORTAINER_API_KEY`), `PORTAINER_URL` (intern erreichbar vom Backend), `PORTAINER_STACK_ID` (steht in der URL des Stacks, `…/stacks/<id>`) und ggf. `PORTAINER_ENDPOINT_ID` (Default 1) setzen. Das Portal liest den Stack (Git- oder Datei-Stack), behält dessen Umgebungsvariablen unverändert und löst ein Redeploy mit Image-Pull aus.

Sicherheit: Webhook-URL und Token können den Stack neu deployen. Am besten einen eigenen Portainer-Benutzer nur mit Zugriff auf dieses eine Stack verwenden (kein Admin) und das Token ausschließlich unter *Admin → Einstellungen* (nur schreibbar) oder in der `.env`/den Docker-Secrets ablegen. Beide Werte erscheinen weder in Antworten noch in Logs. Pro 2 Minuten ist ein Update möglich; jeder Auslöser steht als `system.update` im Audit-Log. Optional senkt `GITHUB_TOKEN` (ohne Rechte) das GitHub-Limit-Risiko; Ergebnisse werden 10 Minuten gecacht.

## Updater (optional)
Opt-in-Profil `updater` in `compose.prod.yaml`: `docker compose -f compose.prod.yaml -f compose.plex.yaml --profile updater up -d` (`compose.plex.yaml` setzt `UPDATE_REPO=LetsManu/friendflix-plex` und `UPDATER_COMPOSE_FILES=compose.prod.yaml,compose.plex.yaml`). Danach aktualisiert *Admin → Update* den Stack selbst (Karte *Updater*: *Jetzt aktualisieren*, *Zurück zur vorherigen Version*, *Updater aktualisieren*, automatische Updates). Einrichtung, Ablauf, Abschalten: [de/setup.md, Updater](de/setup.md#updater-optional) ([English](setup.md#updater-optional)); Bedrohungsmodell: [security.md, Updater](security.md#updater).

- **Dienste:** `docker-proxy` (`ghcr.io/linuxserver/socket-proxy`, per Digest festgenagelt; Dependabot sieht ihn nicht, Tag + Digest von Hand anheben) bindet als einziger `/var/run/docker.sock` ein, schreibgeschützt, Netz `updater-docker` (intern). `updater` (`friendflix-plex-updater`, gebaut, gescannt, signiert und reproduzierbar wie die anderen Images) hängt an `updater` (intern, mit dem Backend), `updater-docker` und `updater-egress` (nur für cosign: GHCR + Sigstore), ohne Port.
- **Ablauf eines Updates:** `compose config` (jedes Image muss genau `ghcr.io/<owner>/<repo>-<dienst>:<tag>` von `UPDATE_REPO` sein) → `compose pull` → `cosign verify` jedes Digests (Identität `https://github.com/<UPDATE_REPO>/.github/workflows/publish.yml@refs/heads/main` bzw. `@refs/tags/vX.Y.Z`, Aussteller `https://token.actions.githubusercontent.com`) → vorherigen Build als `sha-<7>` merken → `compose up -d --no-deps --pull never bootstrap backend gateway web` → Gesundheitsprüfung (Container-Health + `http://backend:3000/health` meldet den neuen Build) bis ca. 3 Minuten → sonst automatisch zurück auf `sha-<7>`. Ein Auftrag zur Zeit; Zustand (Kanal, installierter und vorheriger Tag, letzter Auftrag) im Volume `updater-state`, Protokoll nur im Speicher (feste Meldungen, keine Befehlsausgaben, keine Secrets).
- **Audit:** `system.updater_start` (wer, Aktion, von → nach; `auto` beim automatischen Update) und `system.updater_result` (Ergebnis), Letzteres sobald das Backend nach dem Neustart den Status wieder liest.
- **Fehlersuche:** `docker compose -f compose.prod.yaml -f compose.plex.yaml --profile updater logs updater docker-proxy`. *Signatur abgelehnt* → Images stammen nicht aus diesem Repo/Workflow (eigener Fork: `UPDATE_REPO=<owner>/<repo>`, `FF_REGISTRY=ghcr.io/<owner>`). *Updater lehnt die Signatur ab* (Karte) → `INTERNAL_SECRET` unterscheidet sich zwischen Backend und Updater. `compose_config` → `.env` oder eine Datei aus `UPDATER_COMPOSE_FILES` ist für uid 1000 nicht lesbar.

## Warnband und Status-Seite
Admins sehen im Hauptprofil ein schmales **Warnband** unter der Kopfzeile, sobald auf der Status-Seite etwas gelb oder rot ist (Grenzwerte: [monitoring.md](monitoring.md#zustand-im-portal-admin--status)). Rot steht vor Gelb, jede Meldung ist ein ganzer Satz, „Ansehen“ führt zur Status-Seite (bei offenen Freigaben zur Warteschlange unter *Admin → Nutzer*). „Ausblenden“ gilt pro Admin und Meldung, bis sie sich ändert (andere Stufe oder anderer Grund; nur eine andere Zahl, etwa 86 statt 85 %, blendet sie nicht wieder ein); Ausblendungen werden nach 30 Tagen vergessen. Im Player, in der Watch-Party, im TV-Modus, auf öffentlichen Seiten, in Kinder- und Nebenprofilen erscheint das Band nie.

| Meldung | Was tun |
| --- | --- |
| Medienserver nicht erreichbar | Läuft der Medienserver-Container? Stimmt `JELLYFIN_URL` (interne Adresse; `.env` oder *Admin → Einstellungen → Mediaserver*) und ist der API-Schlüssel noch gültig? Ohne Medienserver läuft keine Wiedergabe. |
| Datenbank / Redis nicht erreichbar | `docker compose ps`, Logs von `postgres` / `redis`; voller Datenträger ist die häufigste Ursache. Das Backend meldet dann auch `/health/ready` als nicht bereit. |
| Gateway nicht erreichbar | Gateway-Container und `GATEWAY_URL` prüfen (Standard `http://gateway:4000`); ohne Gateway laufen keine Streams und Downloads. |
| Login nicht erreichbar / anderer Aussteller | Authentik erreichbar? `OIDC_ISSUER` muss genau dem `issuer` im Discovery-Dokument entsprechen (abschließender Schrägstrich egal). Bestehende Sitzungen laufen weiter, neue Anmeldungen scheitern. |
| Langsam (gelb) | Einmalig harmlos; bleibt es, Last auf dem Host prüfen (Transcodes, Backups, Datenträger). |
| Wunschdienst nicht erreichbar (gelb) | Betrifft nur Wünsche; Container und Schlüssel des Wunschdienstes prüfen. |
| TMDB/OMDb: Schlüssel ungültig, pausiert oder Budget fast aufgebraucht | *Admin → Datenquellen*: Schlüssel testen oder ersetzen (siehe oben). Ohne Schlüssel fehlen nur Zusatzdaten. |
| Wiedergabe-Check: Titel fehlgeschlagen | *Admin → Wiedergabe-Check* zeigt die Titel; meist fehlt die Datei oder sie lässt sich nicht umwandeln (Bibliothekspflege → Datei). |
| Speicher fast voll / zu wenig frei | Downloads: `DOWNLOAD_CACHE_MAX_GB` senken oder alte Lizenzen löschen; Vorschauen: *Admin → Vorschauen* leeren; sonst Datenträger vergrößern. Rot heißt: Vorbereitungen bleiben in der Warteschlange. |
| Download-Cache fast ausgeschöpft | ≥ 90 % von `DOWNLOAD_CACHE_MAX_GB`: alte Downloads laufen aus, oder die Grenze anheben, wenn Platz da ist. |
| Datenbank groß | Über `HEALTH_DB_WARN_GB`: Backups prüfen (dauern länger), ggf. `VACUUM`; die Grenze passt man mit der Variable an. |
| Viele Server-Fehler | Fehlerprotokoll auf der Status-Seite (Route und Status); Backend-Logs zur selben Zeit. |
| Viele Browser-Fehler | Meist nach einem Update: Seite neu laden lassen; `resource` deutet auf ein fehlendes JS-/CSS-Asset (Cache des Proxys). |
| Fehlgeschlagene Wiedergaben | Die Status-Seite listet die Titel der letzten 24 h mit Fehlercode; Datei und Codecs in der Bibliothekspflege prüfen. |
| Anmeldungen warten auf Freigabe (gelb) | Jemand hat sich ohne Einladung angemeldet: *Admin → Nutzer → Warten auf Freigabe* freigeben oder ablehnen (siehe unten). Kein Systemproblem; die Ampel der Status-Seite bleibt davon unberührt. |

## Nutzerverwaltung: Zugang bis, Freigaben, Einladungen
Alles unter *Admin → Nutzer* mit den Reitern **Nutzer**, **Warten auf Freigabe** und **Einladungen** (die alte Adresse `/admin/invites` leitet dorthin um). Jede Änderung steht mit altem und neuem Wert im Audit-Log.

- **Sammelaktionen:** Konten in der Liste ankreuzen, dann Rolle ändern, sperren, entsperren, „Zugang bis“ setzen oder überall abmelden (bis 200 Konten auf einmal, vorher eine Rückfrage mit den Namen). Die Prüfungen gelten für die ganze Auswahl: Ist eine Änderung nicht erlaubt, ändert sich gar nichts. Niemand kann sich selbst sperren oder herabstufen, und der letzte aktive Admin lässt sich weder herabstufen noch sperren (`last_admin`).
- **Zugang bis:** pro Konto ein Enddatum (Detailseite *Zugang verlängern*: +30 / +90 Tage, Datum oder unbegrenzt; in der Liste als Sammelaktion). Ein Timer im Backend prüft jede Minute: **3 Tage vorher** bekommen die Person und alle Admins einmal eine Benachrichtigung, **am Stichtag** wird das Konto gesperrt (Grund „Zugang abgelaufen“, Sitzungen beendet, Medienserver-Nutzer deaktiviert) und alle werden benachrichtigt. Den letzten aktiven Admin sperrt der Timer nie; die Admins erfahren es einmal. Verlängern oder „unbegrenzt“ entsperrt nur Konten, die wegen des Ablaufs gesperrt sind; ein von Hand gesperrtes Konto bleibt gesperrt. Ein Konto, dessen Zugang abgelaufen ist, lässt sich nicht einfach entsperren (der Timer würde es gleich wieder sperren, `access_expired`): Die Detailseite bietet dafür *Zugang verlängern* an.
- **Freigaben:** Wer sich über Authentik ohne gültige Einladung anmeldet (und nicht in `ADMIN_GROUP` ist), bekommt kein Konto und keine Sitzung, sondern die Seite `/pending` („Anfrage gesendet“). Die Admins bekommen pro neuer Anfrage eine Benachrichtigung; meldet sich dieselbe Person erneut an, solange ihre Anfrage offen ist, kommt keine weitere. Das Warnband zeigt die Zahl der offenen Anfragen und erscheint bei jeder Benachrichtigung wieder, auch wenn ein Admin es ausgeblendet hatte. *Freigeben* legt das Konto mit der gewählten Rolle und optional „Zugang bis“ an; die Seite der Person merkt das von selbst (sie fragt alle 30 s nach), danach meldet sie sich erneut an. *Ablehnen* nimmt eine optionale Nachricht mit, die die Person auf `/pending` liest. Meldet sie sich nach einer Ablehnung wieder an, steht die Anfrage erneut in der Liste; benachrichtigt (und das Warnband wieder eingeblendet) wird dann nur, wenn die Ablehnung älter als 24 h ist. Abgelehnte Anfragen werden nach 30 Tagen gelöscht. Wer niemanden ohne Einladung in der Warteschlange haben will, bindet die Anwendung in Authentik an Gruppen ([de/authentik.md §5.2](de/authentik.md#52-anwendung)).
- **Einladungen mit Nutzungen:** *Max. Nutzungen* (1 – 50, Standard 1) legt fest, wie viele Konten ein Link anlegen kann; zwei gleichzeitige Anmeldungen um die letzte Nutzung bekommen nie beide ein Konto. *Zugang (Tage)* (1 – 3650, leer = unbegrenzt) gibt jedem neuen Konto ein „Zugang bis“ ab seiner Anlage. Die Liste zeigt „1/3“, aufgeklappt die Konten aus der Einladung. Die Authentik-Einladung wird erst gelöscht, wenn die letzte Nutzung verbraucht oder die Einladung widerrufen ist.
- **Detailseite** (`/admin/users/<id>`): Nutzung, Profile (umbenennen, PIN zurücksetzen), Geräte und Sitzungen, Downloads, Verlauf, eigene Limits pro Konto (leer = wie die Rolle), Audit-Log; verknüpfte Konten mit *Reparieren*; mit `AUTHENTIK_URL`/`AUTHENTIK_API_TOKEN` auch Zwei-Faktor-Stand und *Passwort-Link senden* (Authentik-Rechte und Wiederherstellungs-Flow: [de/authentik.md §8.2](de/authentik.md#82-rolle-mit-genau-diesen-globalen-berechtigungen), [§10](de/authentik.md#10-passwort-wiederherstellung-per-e-mail)). Der Reiter *Verlauf* zeigt, was die Person geschaut hat; jedes Öffnen wird als `user.activity_viewed` im Audit-Log festgehalten.

## Kontolöschung
Jede Person kann unter *Mein Bereich → Konto* ihre Daten herunterladen und ihr Konto löschen (Ablauf, Inhalt des Exports, Pseudonym und was bleibt: [security.md](security.md#account-self-service), englisch). Für Admins wichtig:

- **Löschung ausstehend:** Nach dem Antrag ist das Konto sofort gesperrt (Grund „Löschung“, alle Sitzungen beendet, Medienserver-Nutzer deaktiviert), und die Admins bekommen eine Benachrichtigung mit Namen und Datum. Die Detailseite zeigt „Löschung am {Datum}“, die Liste hat den Statusfilter *Löschung ausstehend*. Sieben Tage lang kann die Person ihr Konto durch erneutes Anmelden wiederherstellen; der Authentik-Nutzer bleibt dafür so lange aktiv. Der letzte aktive Admin kann sein Konto nicht löschen (`last_admin`).
- **Wiederherstellen / Jetzt löschen:** Auf der Detailseite stellt *Konto wiederherstellen* das Konto wieder her (Entsperren in der Liste, auch als Sammelaktion, tut dasselbe). Ist der Zugang inzwischen abgelaufen, bleibt das Konto gesperrt („Zugang abgelaufen“), bis jemand *Zugang verlängern* nutzt. *Jetzt löschen* (nur bei geplanter Löschung, nicht für das eigene Konto) setzt das Datum auf jetzt; der nächste Durchlauf, spätestens nach einer Minute, beginnt mit der endgültigen Löschung. Beides steht im Audit-Log.
- **Endgültige Löschung:** Ein Timer im Backend prüft jede Minute. Ab dem Moment, in dem er ein Konto übernimmt, lässt es sich nicht mehr wiederherstellen; eine Anmeldung bekommt `403 account_deleted`. Er arbeitet sechs Schritte ab (Medienserver-Nutzer, Wunschdienst-Nutzer, Offline-Lizenzen, FriendFlix-Daten, Audit-Log auf Pseudonym umschreiben, Authentik-Nutzer deaktivieren) und merkt sich den letzten erledigten, ein Neustart setzt also dort fort. Danach bekommen die Admins eine Benachrichtigung mit dem Pseudonym (`deleted-xxxxxxxx`), und im Audit-Log steht `user.deleted`.
- **Bereinigungsfehler:** Scheitert ein Schritt, bekommen die Admins einmal pro Schritt eine Benachrichtigung (nur mit Pseudonym und Schrittnummer), und im Audit-Log steht `user.deletion_failed` mit einem Fehlercode. Die Liste zeigt das Konto unter *Löschung ausstehend* als Zeile „Bereinigung: Schritt n von 6 – Fehler: …“ (nach Schritt 4 nur noch mit Pseudonym, ohne Link). Der Schritt wird **einmal pro Minute ohne Wartezeit-Steigerung wiederholt, bis er gelingt** – ein dauerhaft scheiternder Schritt ruft den Dienst also jede Minute erneut auf, bis ein Admin die Ursache behebt:

| Schritt | Typische Ursache | Was tun |
| --- | --- | --- |
| 1 Medienserver | Medienserver nicht erreichbar, API-Schlüssel ungültig | Medienserver und `JELLYFIN_URL` prüfen (Statusseite). |
| 2 Wunschdienst | Wunschdienst nicht erreichbar, Schlüssel ungültig | `REQUESTS_URL` / `REQUESTS_API_KEY` prüfen. Ein dort schon gelöschter Nutzer gilt als erledigt. |
| 3–5 | Datenbank nicht erreichbar | `docker compose ps`, Logs von `postgres`. |
| 6 Authentik | `authentik_token_rejected`: dem Token fehlt *Can change User*; `authentik_unavailable`: Authentik nicht erreichbar | Blueprint erneut importieren ([de/authentik.md §8.2](de/authentik.md#82-rolle-mit-genau-diesen-globalen-berechtigungen)) oder `AUTHENTIK_URL` prüfen. |

- **Ohne Authentik-API** (`AUTHENTIK_URL`/`AUTHENTIK_API_TOKEN` nicht gesetzt) oder wenn der Authentik-Nutzer nicht gefunden wird, endet die Löschung trotzdem (`user.deleted` mit `authentik: not_configured` bzw. `not_found`), aber der Authentik-Nutzer bleibt aktiv: **Die Person kann sich wieder anmelden und landet als neue Person in *Warten auf Freigabe*** (wer in `ADMIN_GROUP` ist, bekommt stattdessen ein neues Admin-Konto). Den Authentik-Nutzer dann von Hand deaktivieren oder löschen ([de/authentik.md §8.4](de/authentik.md#84-kontoseite-und-kontolöschung)). Auch mit API löscht FriendFlix den Authentik-Nutzer nie; das ist deine Entscheidung.
- **Wo der Name bleiben kann:** Einladungsnotizen, Benachrichtigungen anderer Leute (Listen- und Watch-Party-Einladungen, Empfehlungen samt Notiz), die Admin-Benachrichtigung „Anmeldung wartet auf Freigabe“, `user.rejected`-Einträge einer Anfrage, aus der nie dieses Konto wurde (z. B. abgelehnt, dann über eine Einladung beigetreten), und Freitext anderer Leute (Listen- oder Umfragetitel, Kommentare). Wer das nicht will, löscht oder ändert diese Stellen von Hand. Titel (samt Notiz), die die Person in Listen anderer Leute eingetragen hat, bleiben dort, ohne Angabe, wer sie eingetragen hat.
- **Backups:** Dumps von vor der Löschung enthalten das Konto noch, bis sie nach `BACKUP_KEEP_DAYS` wegfallen. Ein Restore eines solchen Dumps holt das Konto zurück; danach die Löschung erneut anstoßen.

## Bibliothekspflege (Scan)
*Admin → Inhalte → Bibliothekspflege* liest die Bibliothek im Hintergrund (`BACKGROUND_JOBS=true`, nie während einer Anfrage) in Seiten zu 200 Titeln mit kurzer Pause dazwischen. Alle **30 Minuten** werden nur geänderte Titel gelesen (seit dem letzten erfolgreichen Lauf, 5 min Überlappung), beim ersten Start und danach alle **7 Tage** die ganze Bibliothek; nur ein vollständiger Durchlauf entfernt Einträge verschwundener Titel. Meldet der Medienserver neue Titel, läuft ein Scan etwa 2 Minuten später. **„Jetzt prüfen“** startet sofort einen Lauf (höchstens 2 pro 10 Minuten und Admin); die Seite zeigt den Fortschritt und lädt die Liste neu, wenn er fertig ist. „Metadaten neu laden“ bittet den Medienserver, Infos und Bilder eines Titels neu zu holen (höchstens 30 pro Minute). „Ignorieren“ blendet ein Problem für diesen Titel aus, bis man es wieder einblendet. Medienserver ohne die optionalen Methoden zeigen „nicht unterstützt“.

## Release erstellen
Versionen folgen SemVer; die Quelle ist `version.json` im Repo-Wurzelverzeichnis (`{ "version": "1.0.0", "codename": "Arancini" }`). Jede **Hauptversion** bekommt den nächsten Codenamen aus `codenames.json` (Kino-Snacks von A bis Z: 1 Arancini, 2 Brezel, 3 Churros, …). Minor- und Patch-Releases behalten den Codenamen.

1. Unter `## [Unreleased]` im `CHANGELOG.md` stehen die Änderungen seit dem letzten Release (ist der Abschnitt leer, bricht der Workflow ab).
2. GitHub → *Actions* → **Release** → *Run workflow* auf `main`, `bump` wählen: `patch` (Fehlerbehebungen), `minor` (neue Funktionen), `major` (inkompatible Änderungen, neuer Codename). **Erstes Release: mit `none` starten** – das veröffentlicht die Version, die schon in `version.json` steht (1.0.0 Arancini), als `v1.0.0`; existiert ihr Tag bereits, lehnt der Workflow `none` ab.
3. Der Workflow ([release.yml](../.github/workflows/release.yml), Logik in `scripts/release.mjs` mit Tests) erhöht `version.json`, gleicht `version` in allen `package.json` und der `package-lock.json` an, macht aus `## [Unreleased]` den Abschnitt `## [x.y.z] – Codename – JJJJ-MM-TT` (darüber ein neuer, leerer Unreleased-Abschnitt), committet `release: vX.Y.Z Codename` auf `main`, setzt den Tag `vX.Y.Z` und legt das GitHub-Release mit diesem Abschnitt als Notizen an.
4. CI baut den Tag: mit `RELEASE_TOKEN` startet der Push CI von selbst, sonst stößt der Workflow CI für den Tag an (Pushes mit `GITHUB_TOKEN` lösen keine Workflows aus). Nach Tests und Scans veröffentlicht `publish.yml` die Images als `X.Y.Z`, `X.Y`, `X` und – nur wenn es die höchste Version ist – `latest`. Ein Backport-Tag (z. B. `v1.2.4` nach `v1.3.0`), Vorabversionen (`-rc.1`) und andere Tags verschieben `latest` nie.

Vorher lokal ausprobieren, ohne etwas zu ändern: `node scripts/release.mjs minor --dry-run` (zeigt neue Version, Codename, Dateien und die Release-Notizen).

**Token und Branch-Schutz.** GitHub Actions selbst gehört **nicht** in die *Bypass list* eines Rulesets (dann dürfte jeder Workflow, auch ein manipulierter, an `main` vorbei pushen). Stattdessen:

- **Empfohlen – Secret `RELEASE_TOKEN`:** ein fine-grained Personal Access Token (nur dieses Repo, Berechtigung *Contents: Read and write*) oder ein Token einer eigenen GitHub App mit denselben Rechten, als Repository-Secret `RELEASE_TOKEN`. Genau dieser Akteur (dein Konto bzw. die App) steht als einziger in der *Bypass list* der Rulesets für `main` und für `v*`-Tags. Der Workflow checkt damit aus und pusht damit; seine Pushes starten CI für `main` und den Tag selbst.
- **Ohne `RELEASE_TOKEN`:** der Workflow pusht mit `GITHUB_TOKEN` als `github-actions[bot]` und stößt CI für den Tag an. Dann darf `main` für diesen Akteur **nicht** gegen direkte Pushes gesperrt sein (für ein Repo mit dem empfohlenen Branch-Schutz also nur mit `RELEASE_TOKEN` nutzbar).

Der Push ist atomar: scheitert er, entstehen weder Commit noch Tag noch Release.

**Tags schützen:** ein zweites Ruleset (*Target: Tags*, Muster `v*`) mit *Restrict creations*, *Restrict updates* und *Restrict deletions*, Bypass nur für den Release-Akteur (`RELEASE_TOKEN`-Inhaber bzw. Repo-Admins). Wer einen `v*`-Tag anlegen kann, kann Images als Release veröffentlichen.

**Abgebrochenes Release wiederaufnehmen:** Ist der Tag schon gepusht, aber z. B. das GitHub-Release oder der CI-Start fehlgeschlagen, den Lauf mit *Re-run jobs* wiederholen oder neu mit `bump: none` starten. Zeigt der Tag auf einen Commit, dessen `version.json` genau diese Version enthält, überspringt der Workflow Bump, Commit und Push, legt nur das fehlende GitHub-Release an (Notizen aus dem `CHANGELOG.md` am Tag) und startet CI. Jeder andere schon existierende Tag wird abgelehnt. Von Hand geht es so: `gh release create vX.Y.Z --verify-tag --title "vX.Y.Z Codename" --notes-file <(node scripts/release.mjs notes X.Y.Z)` und `gh workflow run ci.yml --ref vX.Y.Z`. Ist dagegen gar nichts gepusht worden, einfach neu starten – lokal ändert der Workflow nichts dauerhaft.

**Auf einer Hauptversion bleiben:** In der `.env` des Stacks `FF_TAG=1` setzen (`compose.prod.yaml` nutzt `…/friendflix-<dienst>:${FF_TAG:-latest}`). Dann ziehen Portainer bzw. `docker compose pull` alle 1.x-Releases, aber nie 2.0. `FF_TAG=1.4` bleibt auf 1.4.x, `FF_TAG=1.4.2` friert genau eine Version ein. `latest` folgt nur dem höchsten Release-Tag, Commits auf `main` erscheinen als `nightly` (siehe [Release-Kanäle](#release-kanäle)).

## Release-Kanäle
Welche Images ein Stack zieht, entscheidet allein `FF_TAG` in der `.env` (`compose.prod.yaml`: `…/friendflix-<dienst>:${FF_TAG:-latest}`):

| `FF_TAG` | Kanal | Was es zieht |
|---|---|---|
| `latest` (Default) | Stabil | das höchste veröffentlichte Release `vX.Y.Z`; Backports und Vorabversionen verschieben es nie |
| `nightly` | Nightly | jeden Commit auf `main`, der CI (Tests, Scans, reproduzierbarer Build) bestanden hat; neuer, aber weniger erprobt |
| `1` / `1.1` / `1.1.0` | festgenagelt | eine Hauptversion, eine Minor-Linie oder genau ein Release (ein Kurz-SHA nagelt genau einen Build fest) |

`publish.yml` baut dafür nichts neu: Ein Push auf `main` taggt das geprüfte Image als `nightly` + Kurz-SHA, ein Tag `vX.Y.Z` als `X.Y.Z`, `X.Y`, `X` + Kurz-SHA und, nur wenn es die höchste Version ist, als `latest`. Ein Release-Image ist also dasselbe Image wie der Nightly-Build seines Commits.

**Kanal wechseln:** `FF_TAG` in der `.env` ändern, dann `docker compose -f compose.prod.yaml -f compose.plex.yaml pull && docker compose -f compose.prod.yaml -f compose.plex.yaml up -d` (in Portainer: Variable im Stack ändern und mit *Re-pull image* neu deployen). Der Wechsel gilt erst danach: Ohne den [Updater](#updater-optional) greift FriendFlix nie selbst auf Docker zu (das Backend bekommt nie den Docker-Socket). Mit dem Updater wählt der Schalter (*Stabil / Nightly / Feste Version*, Einstellungen `UPDATE_CHANNEL` + `UPDATE_VERSION`) direkt, was der Updater installiert; `FF_TAG` ist dann überflüssig.

**Admin → Update** zeigt, auf welchem Kanal die Installation tatsächlich läuft: Ein Build ist ein Release, wenn sein `GIT_SHA` der Commit des Tags `v<Version>` ist (über die GitHub-API nachgeschlagen, 10 Minuten gecacht wie die Update-Prüfung), sonst ein Nightly-Build. Nightly-Builds heißen dort, in der Fußzeile und in `/api/version` z. B. `1.1.0-nightly · abc1234`; ein lokaler Build ohne Commit (`GIT_SHA=dev`) behält seine Versionsangabe. Der Schalter *Stabil / Nightly* speichert die Einstellung `UPDATE_CHANNEL` in der Datenbank (Default `stable`) und legt fest, womit verglichen wird:

- **Stabil:** *Update verfügbar* nur bei einem neueren Release, mit seinen Notizen. Commits auf `main` sind nur Zusatzinfo.
- **Nightly:** neuere Commits auf `main` als der installierte Build (Liste der Änderungen), dazu *Nightly · Build abc1234* für den neuesten Build.

Weicht der gewählte Kanal vom laufenden ab oder gibt es ein Update, zeigt die Seite die passende `.env`-Zeile (`FF_TAG=nightly` bzw. `FF_TAG=latest`) und den Befehl zum Kopieren. Der Knopf *Jetzt aktualisieren* (Portainer) zieht dieselben Tags neu, wechselt also ebenfalls keinen Kanal.

**Umstieg ab 1.1.x:** Bis 1.1.0 folgte `latest` auch `main`. Wer weiter jedem Commit auf `main` folgen will, setzt `FF_TAG=nightly`; ohne Änderung bleibt der Stack ab jetzt auf den Releases.

## Images prüfen: Signatur, SBOM, Provenienz
Jedes veröffentlichte Image (`ghcr.io/<owner>/friendflix-{backend,gateway,web,updater}`, Tags `latest`, `nightly`, Kurz-SHA, `x.y.z`, `x.y`, `x`) ist
- mit **cosign keyless** signiert: kein Schlüssel, kein Secret. Der Publish-Job holt sich per GitHub-OIDC ein kurzlebiges Zertifikat von Sigstore (Fulcio), die Signatur steht im öffentlichen Transparenz-Log (Rekor). Die Identität im Zertifikat ist der Workflow, der signiert hat: `https://github.com/<Owner>/<Repo>/.github/workflows/publish.yml@refs/heads/main` bzw. `@refs/tags/vX.Y.Z`.
- mit **GitHub-Attestations** versehen: SLSA-Provenienz (welcher Commit, welcher Workflow-Lauf) und die SBOM (SPDX, von BuildKit beim Build erzeugt), beide auch in GHCR neben dem Image abgelegt.
- zusätzlich mit den BuildKit-Attestations (SBOM + Provenienz `mode=max`) direkt im Image-Index.

Signiert und attestiert wird nur der Digest, der vorher von Trivy geprüft wurde (siehe Kopf von `.github/workflows/ci.yml`), und nur bei Push auf `main` bzw. `v*`-Tags, nie in Pull Requests. Images von vor dieser Umstellung sind nicht signiert.

Vom Push bis zum laufenden Stack:

```mermaid
---
config:
  flowchart:
    curve: basis
    nodeSpacing: 50
    rankSpacing: 65
    padding: 14
  themeVariables:
    edgeLabelBackground: 'rgba(150,150,150,0.12)'
  themeCSS: '.labelBkg { background-color: rgba(127,127,127,0.12) !important; }'
---
flowchart TB
  accTitle: Vom Commit zum laufenden Stack
  accDescr: CI baut und scannt Images, Publish signiert sie mit cosign und attestiert SBOM und Provenienz, GHCR speichert sie, Portainer oder Compose zieht sie.
  DEV("👩‍💻 <b>Push</b><br/><small>main oder Tag</small>"):::ext
  subgraph GHA["GitHub Actions"]
    CI("🧪 <b>ci.yml</b><br/><small>Test · E2E · ZAP · Build</small>"):::app
    TR("🔍 <b>Trivy</b><br/><small>exakten Digest scannen</small>"):::app
    PB("✍️ <b>publish.yml</b><br/><small>cosign · Attestierungen</small>"):::app
  end
  GH[("📦 <b>GHCR</b><br/><small>friendflix-plex-*</small>")]:::store
  DH("🐳 <b>Docker-Host</b><br/><small>compose / Portainer</small>"):::media
  PT("🪝 <b>Portainer webhook</b><br/><small>Admin → Update</small>"):::svc
  VER("✅ <b>Du prüfst</b><br/><small>cosign verify · gh attestation</small>"):::ext
  DEV --> CI
  CI -->|"ci-&lt;sha&gt;"| TR
  TR -->|sauber| PB
  PB -->|"nightly · latest · sha · x.y.z"| GH
  GH -->|"pull_policy: always"| DH
  PT -.->|neu deployen| DH
  VER -.-> GH
  classDef ext fill:#30363d,stroke:#8b949e,stroke-width:1px,color:#f0f6fc
  classDef edge fill:#2d2a4a,stroke:#9d8cf0,stroke-width:1px,color:#f0f6fc
  classDef app fill:#4a1a24,stroke:#ff4f6d,stroke-width:1px,color:#fff5f7
  classDef store fill:#4a3a14,stroke:#d4a72c,stroke-width:1px,color:#fff8e6
  classDef media fill:#173f30,stroke:#3fb68b,stroke-width:1px,color:#eafff6
  classDef svc fill:#163e4c,stroke:#56b6d6,stroke-width:1px,color:#eaf9ff
  classDef fork fill:#4a1d3c,stroke:#e070b0,stroke-width:1px,stroke-dasharray:4 3,color:#fff0f8
  linkStyle default stroke:#8b949e,stroke-width:1.4px
  style GHA fill:none,stroke:#ff4f6d,stroke-width:1px,stroke-dasharray:4 4
```

> 🟥 FriendFlix · 🟩 Medienserver · 🟦 weitere Dienste · 🟪 Reverse-Proxy · 🟨 Datenspeicher · ⬛ Zuschauer / extern · gestrichelter Rahmen = Netz bzw. Grenze · dicke Linie = Videostream · gepunktet = optional / über öffentliche URL

**Prüfen** (cosign ≥ 3, `gh` ≥ 2.60; Owner im Image-Namen klein geschrieben, in der Identität so wie auf GitHub – das Regex unterscheidet Groß-/Kleinschreibung):
```bash
IMG=ghcr.io/letsmanu/friendflix-plex-backend:latest      # bzw. :nightly, :<sha> oder :<x.y.z>, gateway / web genauso

# Signatur: muss aus einem Workflow dieses Repos stammen, ausgestellt für GitHub Actions
cosign verify "$IMG" \
  --certificate-identity-regexp '^https://github.com/LetsManu/friendflix-plex/.github/workflows/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# Provenienz (Standard-Prädikat SLSA) und SBOM (gh lädt die Attestations aus der GitHub-API, braucht `gh auth login`)
gh attestation verify "oci://$IMG" --repo LetsManu/friendflix-plex
gh attestation verify "oci://$IMG" --repo LetsManu/friendflix-plex --predicate-type https://spdx.dev/Document/v2.3
#   ohne GitHub-Login: --bundle-from-oci (liest die Attestations aus GHCR)

# SBOM / Provenienz ansehen
docker buildx imagetools inspect "$IMG" --format '{{ json .SBOM.SPDX }}' | jq '.packages | length'
docker buildx imagetools inspect "$IMG" --format '{{ json .Provenance.SLSA }}' | jq . | head -40
```
Strenger (nur `main` und Versions-Tags): `--certificate-identity-regexp '^https://github\.com/LetsManu/friendflix-plex/\.github/workflows/publish\.yml@refs/(heads/main|tags/v.+)$'`.

**Forks** (z. B. die Plex-Variante) brauchen keine Anpassung an den Workflows: Image-Namen und Signatur-Identität leiten sich vom Repo ab, in dem der Workflow läuft. Beim Prüfen `letsmanu`/`LetsManu/friendflix` durch den eigenen Owner bzw. `<owner>/<repo>` ersetzen.

**Beim Deployment** am besten einen geprüften Digest pinnen statt `latest`: `docker buildx imagetools inspect "$IMG" --format '{{.Manifest.Digest}}'`, prüfen, dann in `compose.prod.yaml` per `FF_TAG` den Tag (oder direkt `image: …@sha256:…`) setzen.

**Reproduzierbar nachbauen:** Jedes Image lässt sich aus dem Quellcode bitgenau nachbauen (gleicher Digest des linux/amd64-Image-Manifests), z. B. für ein Release:
```bash
git clone https://github.com/LetsManu/friendflix-plex && cd friendflix-plex
scripts/reproduce-image.sh backend --ref v1.4.0 --compare ghcr.io/letsmanu/friendflix-plex-backend:1.4.0
```
Das Skript baut aus `git archive` mit `SOURCE_DATE_EPOCH` = Commit-Zeit, `rewrite-timestamp=true`, ohne Cache und mit der in `ci.yml` gepinnten BuildKit-Version. Was verglichen wird, was nicht (Attestations, Index-Digest) und wo die Grenze liegt (Alpine-Pakete): [reproducible-builds.md](reproducible-builds.md). Der CI-Job `reproducible` prüft das bei jedem PR (zwei saubere Builds) und jedem Push (Nachbau gegen den gepushten Kandidaten); `publish` wartet auf ihn.

## Weitere Prüfungen in der Pipeline
- **DAST:** Der CI-Job `dast` startet die gebaute Web-App und lässt einen **OWASP-ZAP-Baseline-Scan** darüber laufen (schlägt bei „High“ fehl, warnt bei „Medium/Low“; Regeln und bewusste Ausnahmen in `.zap/rules.tsv`, Bericht als Artefakt `zap-report`). `publish` wartet auf ihn.
- **Lieferkette:** Trivy (Image-Digest), gitleaks (Secrets), `npm audit` und der **OpenSSF Scorecard** ([scorecard.yml](../.github/workflows/scorecard.yml), wöchentlich und bei jedem Push auf `main`, Ergebnis im Code-Scanning und als Badge im README).
- Der Sprach- und der Bildqualitäts-Index werden von Hintergrundjobs gepflegt (`BACKGROUND_JOBS=true`, höchstens alle 12 h; beim ersten Start laufen sie sofort). Bis dahin sind die Filter „Ton / Untertitel“ und „Bildqualität“ unvollständig; ebenso laufen die Bald-weg-Erinnerungen nur mit diesem Schalter.

## Empfohlener Branch-Schutz
GitHub → *Settings* → *Rules* → *Rulesets* (oder *Branches* → *Branch protection rule*) für `main`:
- **Require a pull request before merging** (ohne Pflicht-Review reicht für ein Ein-Personen-Projekt), **Block force pushes**, **Restrict deletions**.
- *Bypass list*: nur der Akteur hinter `RELEASE_TOKEN` (für den Release-Commit), nie „GitHub Actions“. Dazu ein Tag-Ruleset für `v*` (siehe *Release erstellen*).
- **Require status checks to pass** mit genau diesen Checks aus `.github/workflows/ci.yml` (Namen wie in der Auswahl; sie erscheinen dort erst, nachdem sie einmal gelaufen sind):
  `test (22)`, `test (26)`, `e2e`, `dast`, `secrets`, `docker (backend)`, `docker (gateway)`, `docker (web)`,
  `reproducible (backend)`, `reproducible (gateway)`, `reproducible (web)`
- **Require branches to be up to date before merging** (*Require status checks to pass* → *Require branches to be up to date before merging*): die Checks müssen gegen den aktuellen Stand von `main` gelaufen sein.
- Optional: den Check der CodeQL-Standardeinrichtung (Name erscheint nach dem ersten Lauf) bzw. unter Rulesets **Require code scanning results** für CodeQL.
- Nicht als Pflicht-Check eintragen: `publish / …` und `Scorecard analysis` (laufen nur bei Push bzw. zeitgesteuert, nie in einem PR – der PR würde ewig warten).

## Bitrate-Limit unterwegs (`HOME_NETWORKS`)
Jede Rolle hat zusätzlich zur normalen Bitrate-Grenze ein **Limit unterwegs** (Admin → Rollen, Feld „Limit unterwegs“; Standard 8 Mbit/s für Freund und Familie, 4 Mbit/s für Gast, 12 Mbit/s für Admin, nie höher als das Rollenlimit). Es gilt, wenn jemand **nicht** im Heimnetz schaut: Der Upload des Servers ist begrenzt, ein Stream über der Leitung ruckelt für alle. Backend (`POST /api/playback/info`) und Gateway (`MaxStreamingBitrate` der Medien-Anfragen) kappen die Bitrate, der Player kann sie nicht erhöhen. Chromecast-Sitzungen (`POST /api/cast/session`) folgen demselben Limit unterwegs: Das Token speichert die gekappte Bitrate, das Gateway kappt die Cast-Anfragen darauf. Plan B (`/internal/authz-nginx`) kennt die Client-Adresse nicht und wendet nur das normale Rollenlimit an.

**`HOME_NETWORKS`** (Env, kommagetrennte CIDRs) legt fest, was als Heimnetz gilt. Standard: `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,::1/128,fc00::/7,fe80::/10` (RFC1918, Loopback, IPv6 ULA/Link-Local; IPv4-mapped IPv6 wird erkannt). Unbekannte oder nicht auswertbare Adressen zählen als **unterwegs**.

**Client-Adresse:** zuerst `X-Real-IP`, sonst der **letzte** `X-Forwarded-For`-Eintrag (den hängt der eigene Proxy an), sonst der Socket-Peer. Der linkeste Eintrag wird bewusst ignoriert, weil ihn der Client selbst setzt. Ohne beide Header zählt im Backend nur Loopback als Heimnetz; ein Docker-Bridge-Peer gilt als unterwegs. Der Reverse Proxy (NPM) muss deshalb `X-Real-IP` bzw. `X-Forwarded-For` setzen, sonst werden alle Zuschauer gleich behandelt. **Wichtig:** `X-Real-IP` hat Vorrang, also muss der Proxy diesen Header **überschreiben** (`proxy_set_header X-Real-IP $remote_addr;`) oder entfernen. Ein Proxy, der nur `X-Forwarded-For` anhängt und ein mitgeschicktes `X-Real-IP` durchreicht, lässt Clients das Heimnetz vortäuschen (`X-Real-IP: 192.168.1.5`) und so das Limit unterwegs umgehen. Die mitgelieferte NPM-Konfiguration (`deploy/npm/portal.advanced.conf`) überschreibt beide Header bereits.

**Direct Play unterwegs:** Das Gateway kappt transkodierte Streams (HLS: fehlende `MaxStreamingBitrate`/`VideoBitrate` setzt es auf das Limit, höhere Werte senkt es). Den Originalstream (`/Videos/<id>/stream`) kann es nicht kappen, weil es die Bitrate der Datei nicht kennt: Rollen ohne Höhenbegrenzung dürfen ihn (mit dem Standard `DIRECT_PLAY_REQUIRES_DOWNLOAD=false`) auch unterwegs abrufen, etwa per Skript mit ihrem Cookie, und so mehr als das Limit unterwegs ziehen. Der Player selbst fordert unterwegs nur an, was das Backend-Limit erlaubt. Wer den Upload streng schützen muss, setzt `DIRECT_PLAY_REQUIRES_DOWNLOAD=true`: Dann bekommen nur Rollen mit Download-Recht den Originalstream (mehr Transcoding-Last, siehe [downloads.md](downloads.md)).

## Plan B: NPM liefert /media/ direkt (auth_request)
Standard ist das Node-Gateway. Wird es bei vielen parallelen Streams zum Engpass (CPU des `gateway`-Containers, `rate(friendflix_gateway_bytes_total)`), kann NPM/nginx `/media/` selbst ausliefern. Jede Anfrage wird vorher vom Backend freigegeben (`GET /internal/authz-nginx`).

**Ablauf je Request:** Browser → nginx → `auth_request` an Backend (Cookie + Original-URI + Shared Secret) → Backend prüft Session, Gerätefreigabe, Sperre und die Pfad-Allowlist, liefert nur Header zurück (`X-Jellyfin-Uri` = bereinigte URI mit Bitrate-Limit, `X-Jellyfin-Auth` = Jellyfin-Token des Nutzers) → nginx streamt von Jellyfin. Der Browser sieht nie ein Token.

**Einrichten**
1. Jellyfin muss vom NPM-Host erreichbar sein, ohne öffentlich zu sein: Stack mit `docker compose -f compose.yaml -f compose.planb.yaml --profile bundled up -d` starten. Das veröffentlicht Jellyfin **nur auf `127.0.0.1:8096`**. Port 8096 bleibt in der Host-Firewall gesperrt. (Läuft Jellyfin außerhalb des Stacks, muss es auf `127.0.0.1:8096` für NPM erreichbar und von außen gesperrt sein.)
2. In NPM → Proxy Host → Advanced: den `location /media/`-Block aus `portal.advanced.conf` **ersetzen** durch den Inhalt von `deploy/npm/plan-b-auth-request.conf`; `__INTERNAL_SECRET__` durch das `INTERNAL_SECRET` ersetzen. Steht es in der `.env` (ältere Installation), diesen Wert nehmen; sonst liegt es im Volume `bootstrap` (mit `compose.secrets.yaml`: `secrets/internal_secret`). Ohne es auf dem Bildschirm oder in einem geteilten Log auszugeben, direkt in eine lokale Kopie schreiben (gleiche `-f`-Dateien wie beim Start):
   ```bash
   S=$(docker compose run --rm --no-deps -T --entrypoint cat backend /run/friendflix/internal_secret)
   ( umask 077; sed "s|__INTERNAL_SECRET__|$S|" deploy/npm/plan-b-auth-request.conf > plan-b.local.conf ); unset S
   ```
   Den Inhalt von `plan-b.local.conf` in NPM einfügen und die Datei danach löschen (`rm plan-b.local.conf`; nie committen).
3. Gateway-Container kann gestoppt werden (`docker compose stop gateway`).
4. Testen: `curl -I https://friend.example.com/media/Videos/<id>/master.m3u8` ohne Cookie → **401**; im Browser abspielen → läuft.

**Sicherheitsmerkmale (automatisiert geprüft mit `scripts/test-plan-b.sh` gegen echtes nginx):** 401 ohne/mit falscher Session, 403 außerhalb der Allowlist und bei Traversal, nur GET/HEAD, `/internal/` öffentlich 404, Client-`Authorization`/`X-Emby-*` erreichen Jellyfin nie, `api_key` wird entfernt, Bitrate wird auf das Rollenlimit gekappt, Token nur serverseitig, kein `Set-Cookie`/Token in Antworten, Range → 206.
Backend-Tests prüfen dieselben Pfad-Vektoren wie das Gateway (`test-vectors/media-paths.json`), damit beide Allowlists nicht auseinanderlaufen. Entscheidungen werden als `friendflix_authz_nginx_total{result}` gezählt.

**Grenzen:** Das Secret steht in der NPM-Konfiguration (es autorisiert nur den Auth-Endpunkt, der zusätzlich eine echte Session verlangt). Sperren/Abmelden wirken nach spätestens ~5 s (Memo im Backend). Durchsatz/Streams erscheinen nicht in den Gateway-Metriken, sondern in den NPM-/nginx-Logs. Bild-Caching setzt die Konfiguration selbst (`private, max-age=86400`).
