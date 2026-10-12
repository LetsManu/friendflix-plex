# Betrieb: Backup, Restore, Firewall, Updates

## Backups & Wiederherstellung
**Aktivieren** (opt-in, Compose-Profil `backup`; gilt für `compose.yaml` und `compose.prod.yaml`):
```bash
mkdir -p backups && chown 70 backups          # Container läuft als postgres-User (uid 70)
docker compose --profile backup up -d backup  # bzw. -f compose.yaml -f compose.prod.yaml --profile backup ...
docker compose logs -f backup                 # eine Zeile pro Lauf: "backup: OK <datei> (<bytes>), kept N dumps" oder "FAIL exit=<rc>"
```
- Der Sidecar nutzt `postgres:17-alpine` (gleiche Major-Version wie `postgres`; beim Upgrade beide gemeinsam anheben) und läuft täglich um `BACKUP_HOUR` (Default 3, Zeitzone aus `TZ`). Optional `BACKUP_RUN_ON_START=true` für einen Sofort-Dump beim Start.
- **Ablauf je Lauf:** `pg_dump -Fc` in eine `.tmp`-Datei, Prüfung mit `pg_restore --list`, erst dann Umbenennen nach `friendflix-YYYYmmdd-HHMM.dump`; danach werden Dumps älter als `BACKUP_KEEP_DAYS` (Default 14) gelöscht. Schlägt ein Schritt fehl, bleibt der letzte gute Dump unangetastet, die Logzeile zeigt `FAIL exit=<rc>` und der Container wird `unhealthy` (`docker compose ps`; für Alarme z. B. Portainer/Icinga auf den Health-Status).
- **Ablageort:** Host-Verzeichnis `BACKUP_PATH` (Default `./backups`) → `/backups` im Container. Das Passwort kommt aus `POSTGRES_PASSWORD` (wie beim `postgres`-Dienst) oder aus einer gemounteten Datei (`BACKUP_PGPASSWORD_FILE`), nie aus dem Image oder dem Dump-Verzeichnis.
- Alternativ per Cron auf dem Host: `0 3 * * * cd /opt/friendflix && ./scripts/backup.sh >> backups/backup.log 2>&1`
- **Off-site:** Dumps zusätzlich auf ein anderes Gerät kopieren, ein Backup auf derselben Platte schützt nicht vor Plattenausfall. Beispiel TerraMaster-NAS: `BACKUP_PATH` auf ein NAS-Share legen (NFS/SMB) und dort Snapshots aktivieren, oder per Cron `rsync -a --delete-after backups/ nas:/volume1/backups/friendflix/`. Den Schlüssel `APP_ENC_KEY` separat im Passwort-Manager sichern.

**Wiederherstellung** (App gestoppt, damit keine Verbindungen offen sind):
```bash
docker compose stop backend gateway
docker compose exec -T postgres pg_restore --clean --if-exists --no-owner -U friendflix -d friendflix < backups/friendflix-<ts>.dump
docker compose start backend gateway
```
Bei einer leeren/neuen Datenbank zuerst den Stack mit `postgres` starten (`docker compose up -d postgres`) und dann wie oben einspielen. Migrationen laufen beim Start des Backends ggf. nach.

**Restore-Test** (monatlich per Cron, Exit-Code ≠ 0 bei Fehler → Icinga/Cron-Mail): `./scripts/restore-test.sh`
Startet einen Wegwerf-Postgres ohne Port-Mapping, spielt den neuesten Dump ein und prüft Migrationen und Tabellen. Schnellprüfung einer einzelnen Datei: `docker compose exec -T postgres pg_restore --list < backups/<datei>.dump | head`.

- **APP_ENC_KEY sichern!** (Passwort-Manager, getrennt vom Dump). Ohne ihn sind die gespeicherten Jellyfin-Passwörter der Nutzer unlesbar.
- Nicht im Dump: Jellyfin-/Seerr-/Authentik-Daten (eigene Backups dieser Dienste).

## Host-Firewall (zusätzlich zum fehlenden Port-Mapping)
Jellyfin/Seerr haben keine `ports:` und hängen nur im internen Netz. Falls sie auf dem Host zusätzlich laufen (nicht gebündelt):
```bash
# Docker umgeht ufw: Regeln gehören in DOCKER-USER
iptables -I DOCKER-USER -p tcp -m multiport --dports 8096,8920,5055 ! -s 127.0.0.1 -j DROP
ufw deny 8096,8920,5055/tcp
```
Prüfung von außen: `nmap -p 8096,8920,5055 <öffentliche-IP>` → alle `filtered/closed`.

## Updates
`git pull && docker compose build --pull && docker compose up -d`. Migrationen laufen beim Start (Advisory-Lock, transaktional).
Nach Jellyfin-Updates: `JELLYFIN_URL=… ./scripts/gen-jellyfin-client.sh` und Diff prüfen (Pfade ändern sich zwischen Versionen; der Client probiert alte/neue Pfade für Views/Resume/Item/Favoriten/Gesehen).

## Updates aus dem Portal
*Admin → Update* vergleicht die installierte Version (`GIT_SHA`, beim Image-Build eingebacken) mit dem letzten erfolgreichen CI-Lauf auf `main`, listet die Änderungen und kann das Portainer-Stack sofort neu ziehen. Portainer selbst zieht Images ohnehin alle 12 Stunden. Der Knopf bleibt deaktiviert, solange eine der beiden Varianten fehlt:

- **Webhook (einfach):** In Portainer → Stacks → *dein Stack* → *Stack-Webhook* aktivieren, URL kopieren und als `PORTAINER_WEBHOOK_URL` setzen. Die URL enthält ein Token und ist ein Secret (auch als `PORTAINER_WEBHOOK_URL_FILE` möglich).
- **API:** In Portainer → *My account* → *Access tokens* ein Token anlegen (`PORTAINER_API_KEY`), `PORTAINER_URL` (intern erreichbar vom Backend), `PORTAINER_STACK_ID` (steht in der URL des Stacks, `…/stacks/<id>`) und ggf. `PORTAINER_ENDPOINT_ID` (Default 1) setzen. Das Portal liest den Stack (Git- oder Datei-Stack), behält dessen Umgebungsvariablen unverändert und löst ein Redeploy mit Image-Pull aus.

Sicherheit: Webhook-URL und Token können den Stack neu deployen. Am besten einen eigenen Portainer-Benutzer nur mit Zugriff auf dieses eine Stack verwenden (kein Admin) und das Token ausschließlich in der `.env`/den Docker-Secrets ablegen. Beide Werte erscheinen weder in Antworten noch in Logs. Pro 2 Minuten ist ein Update möglich; jeder Auslöser steht als `system.update` im Audit-Log. Optional senkt `GITHUB_TOKEN` (ohne Rechte) das GitHub-Limit-Risiko; Ergebnisse werden 10 Minuten gecacht.

## Plan B: NPM liefert /media/ direkt (auth_request)
Standard ist das Node-Gateway. Wird es bei vielen parallelen Streams zum Engpass (CPU des `gateway`-Containers, `rate(friendflix_gateway_bytes_total)`), kann NPM/nginx `/media/` selbst ausliefern. Jede Anfrage wird vorher vom Backend freigegeben (`GET /internal/authz-nginx`).

**Ablauf je Request:** Browser → nginx → `auth_request` an Backend (Cookie + Original-URI + Shared Secret) → Backend prüft Session, Gerätefreigabe, Sperre und die Pfad-Allowlist, liefert nur Header zurück (`X-Jellyfin-Uri` = bereinigte URI mit Bitrate-Limit, `X-Jellyfin-Auth` = Jellyfin-Token des Nutzers) → nginx streamt von Jellyfin. Der Browser sieht nie ein Token.

**Einrichten**
1. Jellyfin muss vom NPM-Host erreichbar sein, ohne öffentlich zu sein: Stack mit `docker compose -f compose.yaml -f compose.planb.yaml --profile bundled up -d` starten. Das veröffentlicht Jellyfin **nur auf `127.0.0.1:8096`**. Port 8096 bleibt in der Host-Firewall gesperrt. (Läuft Jellyfin außerhalb des Stacks, muss es auf `127.0.0.1:8096` für NPM erreichbar und von außen gesperrt sein.)
2. In NPM → Proxy Host → Advanced: den `location /media/`-Block aus `portal.advanced.conf` **ersetzen** durch den Inhalt von `deploy/npm/plan-b-auth-request.conf`; `__INTERNAL_SECRET__` durch den Wert aus `.env` ersetzen.
3. Gateway-Container kann gestoppt werden (`docker compose stop gateway`).
4. Testen: `curl -I https://portal.example.com/media/Videos/<id>/master.m3u8` ohne Cookie → **401**; im Browser abspielen → läuft.

**Sicherheitsmerkmale (automatisiert geprüft mit `scripts/test-plan-b.sh` gegen echtes nginx):** 401 ohne/mit falscher Session, 403 außerhalb der Allowlist und bei Traversal, nur GET/HEAD, `/internal/` öffentlich 404, Client-`Authorization`/`X-Emby-*` erreichen Jellyfin nie, `api_key` wird entfernt, Bitrate wird auf das Rollenlimit gekappt, Token nur serverseitig, kein `Set-Cookie`/Token in Antworten, Range → 206.
Backend-Tests prüfen dieselben Pfad-Vektoren wie das Gateway (`test-vectors/media-paths.json`), damit beide Allowlists nicht auseinanderlaufen. Entscheidungen werden als `friendflix_authz_nginx_total{result}` gezählt.

**Grenzen:** Das Secret steht in der NPM-Konfiguration (es autorisiert nur den Auth-Endpunkt, der zusätzlich eine echte Session verlangt). Sperren/Abmelden wirken nach spätestens ~5 s (Memo im Backend). Durchsatz/Streams erscheinen nicht in den Gateway-Metriken, sondern in den NPM-/nginx-Logs. Bild-Caching setzt die Konfiguration selbst (`private, max-age=86400`).
