# FriendFlix for Plex – Einrichtung

> **Status: in Entwicklung / Preview.** Die Plex-Unterstützung wird gerade gebaut und ist **noch nicht veröffentlicht**. Diese Anleitung beschreibt das Zielsetup des ersten Preview-Releases; Namen wie `compose.plex.yaml` und die Images `friendflix-plex-*` sind geplant. Aussagen zum Verhalten von Plex wurden gegen einen echten Plex Media Server 1.43 geprüft; was als *geplant* steht, sind Entwurfsentscheidungen, die noch nicht umgesetzt sind.
>
> Du nutzt Jellyfin? Dann nimm das Originalprojekt [LetsManu/friendflix](https://github.com/LetsManu/friendflix). English: [../plex.md](../plex.md).

Zurück zur [README](../../README.de.md).

## So funktioniert es in einer Minute

- **Ein Plex-Server pro FriendFlix-Instanz.**
- FriendFlix verwaltet seine Nutzer selbst mit **einem Plex-Admin-Token**. Deine Freunde brauchen kein plex.tv-Konto, und es funktioniert ohne Plex Pass.
- Profile, Kinderprofile, Altersgrenzen, Wiedergabefortschritt und Favoriten liegen **in FriendFlix**, nicht in Plex. FriendFlix schreibt nie Wiedergabestatus nach Plex.
- Das Token benutzen nur Gateway und Backend auf dem Server. Es geht nie an einen Browser; Clients sehen nur FriendFlix-URLs.
- `compose.plex.yaml` **verbindet nur mit deinem vorhandenen Plex-Server** (`PLEX_URL`, `PLEX_TOKEN` oder `PLEX_TOKEN_FILE`). Es startet keinen Plex-Container.

## 1. Server claimen

FriendFlix braucht einen **geclaimten** Server und ein Token. Ein ungeclaimter Plex-Server beantwortet tokenlose Anfragen nur von der Maschine, auf der er läuft; aus einem Container oder von einem anderen Host ist er so nicht nutzbar.

1. Plex-Web-App öffnen (`http://<server>:32400/web`) und mit einem Plex-Konto anmelden. Damit ist der Server geclaimt.
2. Bei Plex im Docker kannst du beim ersten Start mit einem Claim-Token von <https://plex.tv/claim> claimen (`PLEX_CLAIM`); das Token gilt nur wenige Minuten.

## 2. Admin-Token holen

Folge dem Plex-Supportartikel **„Finding an authentication token / X-Plex-Token“** (diesen Titel auf support.plex.tv suchen). Das Token wird als `X-Plex-Token` gesendet.

Empfehlungen:

- Nimm ein **eigenes Plex-Konto** (mindestens ein eigenes Token) für FriendFlix, nicht dein Alltagskonto. Plex speichert die gewählte Tonspur pro Plex-Konto, und FriendFlix muss sie ändern, wenn jemand eine Sprache wählt (siehe [Tonspuren](#tonspuren)). Nutzen andere Plex-Apps dasselbe Konto, sehen sie diese Änderungen.
- Das Token ist ein Passwort: Lege es möglichst in `PLEX_TOKEN_FILE` (Docker Secret, siehe `compose.secrets.yaml`) statt in `.env` und poste es nie in Issues oder Chats. Ist es durchgesickert, widerrufe es wie in der Plex-Dokumentation beschrieben (z. B. das Gerät in den autorisierten Geräten deines Kontos entfernen) und erzeuge ein neues.

Prüfen von der Maschine aus, auf der FriendFlix läuft:

```bash
curl -s -H "X-Plex-Token: $PLEX_TOKEN" -H "Accept: application/json" "$PLEX_URL/identity"
```

`"claimed": true` und eine Versionsnummer heißen: Server erreichbar; `401` heißt: Token falsch oder Server nicht geclaimt.

## 3. FriendFlix konfigurieren

```bash
# .env (geplante Variablennamen)
MEDIA_SERVER=plex
PLEX_URL=http://192.168.1.10:32400
PLEX_TOKEN=...            # oder PLEX_TOKEN_FILE=/run/secrets/plex_token

docker compose -f compose.prod.yaml -f compose.plex.yaml up -d   # kommt mit dem ersten Preview-Release
```

Images (geplant): `ghcr.io/letsmanu/friendflix-plex-backend`, `-web`, `-gateway`.

### Netzwerk

- **Gateway und Backend müssen `PLEX_URL` erreichen.** Nimm die **lokale Adresse** des Plex-Servers (LAN-IP oder ein Name, den der Docker-Host auflöst, Port 32400). Nicht die öffentliche `plex.direct`-/Fernzugriff-Adresse: Sie bringt Latenz, kann über Plex' Relay laufen und ist unnötig.
- Browser müssen Plex nicht erreichen. Öffentlich ist nur das FriendFlix-Portal.
- Läuft Plex auf demselben Host in Docker, hänge beide in ein gemeinsames Docker-Netz oder nimm die LAN-IP des Hosts.
- FriendFlix sendet immer das Token und hängt deshalb nicht davon ab, dass Plex die Verbindung als „lokal“ einstuft.

## 4. Bibliotheksnamen und Zugriff pro Rolle

FriendFlix spiegelt deine Plex-Bibliotheken (Sections) und lässt dich **pro Rolle festlegen, welche Bibliotheken sichtbar sind** (z. B. die Rolle *Kinder* sieht nur `Kinderfilme` und `Kinderserien`).

- Gib Bibliotheken klare, stabile Namen. Mit diesen Namen wählst du sie im Admin-Bereich.
- Lege Inhalte, die nur manche sehen sollen (Kinder, Erwachsene, Familienvideos), in eigene Bibliotheken, statt dich nur auf Altersfreigaben zu verlassen.
- Eine für die Rolle nicht erlaubte Bibliothek ist unsichtbar – auch in Suche, Empfehlungen und bei direkten Links.
- *Geplant:* Der Zugriff hängt an der Bibliothek, nicht am Namen; Umbenennen in Plex sollte ihn nicht entfernen, prüfe danach aber die Rolleneinstellungen.

## 5. Altersfreigaben

Altersgrenzen und Kinderprofile stützen sich auf die Plex-**Altersfreigabe** (`contentRating`) jedes Titels.

- FriendFlix ordnet gängigen Plex-Freigaben ein Mindestalter zu (z. B. `G`, `PG`, `PG-13`, `R`, `NC-17`, `TV-Y`, `TV-G`, `TV-PG`, `TV-14`, `TV-MA` und Werte mit Länderpräfix wie `de/12`). Die vollständige Tabelle wird hier aufgeführt und liegt nach der Umsetzung in `backend/src/plex/`.
- **Unbekannte oder leere Freigaben sind für Profile mit Altersgrenze und für Kinderprofile gesperrt** (im Zweifel zu). Profile ohne Grenze sehen alles, was ihre Rolle erlaubt.
- Folgen erben die Freigabe ihrer Serie, sofern sie keine eigene haben.

Falsche oder fehlende Freigabe in Plex korrigieren:

1. Titel in Plex öffnen, **Bearbeiten** (Stift) → **Erweitert** → **Altersfreigabe** (Content Rating).
2. Einen gängigen Wert eintragen und das Feld **sperren**, damit eine Metadaten-Aktualisierung es nicht überschreibt.
3. Plex ändert beim Bearbeiten von Metadaten das Änderungsdatum des Titels **nicht**; FriendFlix kann es daher nicht allein an Zeitstempeln erkennen. Es prüft alle Freigaben in regelmäßigen Durchläufen und hört auf Plex-Benachrichtigungen (*geplant*); eine Änderung kann einige Minuten brauchen.

Tipp: In Plex die Bibliothek nach *Altersfreigabe* filtern, um Titel ohne Freigabe zu finden. „Zuordnung korrigieren“ (Fix Match) füllt die Freigabe oft aus.

## 6. Vorschaubilder (Spulen)

Vorschau beim Spulen braucht Plex' **Video-Vorschaubilder** (BIF-Dateien). Sie funktionieren ohne Plex Pass, sind aber standardmäßig aus.

1. Plex → **Einstellungen → Bibliothek → „Video-Vorschaubilder erstellen“**: auf *als geplante Aufgabe* oder *so schnell wie möglich* stellen.
2. Pro Bibliothek: **Verwalten → Bibliothek bearbeiten → Erweitert → Video-Vorschaubilder aktivieren**.
3. Vorhandene Titel analysieren (**…** → *Analysieren*) oder die geplante Aufgabe abwarten.

Ohne sie zeigt FriendFlix keine Vorschaubilder beim Spulen. Mit ihnen zeigt es Einzelbilder (etwa alle 2 s), kein durchgehendes Sprite-Bild.

## 7. Plex Pass (optional)

Du brauchst **kein** Plex Pass für FriendFlix. Plex Pass bringt nur zusätzliche Dinge, die FriendFlix dann nutzen kann:

- **Intro / Abspann überspringen**: braucht Intro- und Abspann-Marker, die Plex nur mit Plex Pass erkennt. Ohne Marker erscheint der Knopf nie. Recap und Vorschau überspringen gibt es nie.
- **Hardware-Transcoding** ist eine Plex-Funktion (laut Plex braucht sie Plex Pass). Sie wird in Plex eingestellt, nicht in FriendFlix.

## 8. Plex-Einstellungen, die du lassen kannst

- Lege in Plex **keine** Nutzer, Home-Nutzer oder Freigaben für FriendFlix-Mitglieder an; FriendFlix nutzt sie nicht.
- **Fernzugriff / Relay** kannst du halten, wie du willst; FriendFlix nutzt ihn nicht.
- **Transcoder-Einstellungen** (temporäres Verzeichnis, Qualität) kannst du lassen oder für deine Hardware anpassen; FriendFlix fordert vom Plex-Transcoder nur HLS-Streams an.
- Bibliotheken nicht ohne Not löschen und neu anlegen: Titel können neue interne IDs bekommen, FriendFlix könnte sie als neu behandeln (Fortschritt, Listen und Favoriten folgen dann nicht).

## Funktionsvergleich

| Funktion | Plex | Hinweis |
|---|---|---|
| Profile, Kinderprofile, PIN, Altersgrenzen | Funktioniert | In FriendFlix; braucht korrekte `contentRating` |
| Bibliothek, Suche, Detailseiten, Besetzung, Bilder | Funktioniert | Titel-Logos nur, wenn Plex sie liefert, sonst Titeltext |
| Weiterschauen, Meine Liste, Favoriten, Bewertungen, Verlauf | Funktioniert | In FriendFlix |
| Direct Play | Funktioniert | Datei wird über Plex gestreamt |
| Adaptives Streaming (HLS) | Funktioniert | MPEG-TS-Segmente vom Plex-Universal-Transcoder, vom Gateway umgeschrieben |
| Untertitel | Funktioniert | Text-Untertitel extrahiert/in WebVTT gewandelt von FriendFlix; kein PGS |
| Tonspur wählen | Eingeschränkt | Pro Plex-Konto; Stream-Starts laufen nacheinander |
| Intro / Abspann überspringen | Eingeschränkt | Nur mit Plex-Pass-Markern; nie Recap/Vorschau |
| Vorschaubilder beim Spulen | Eingeschränkt | Einzelbilder; braucht aktivierte Vorschaubilder |
| „Demnächst erscheinende Folgen“ | Nicht verfügbar | |
| Offline-Downloads | Funktioniert | Von FriendFlix umgepackt (Remux) |
| TV-Modus, Chromecast, Watch-Partys, Empfehlungen, Benachrichtigungen | Funktioniert | FriendFlix-Funktionen |
| Wünsche (Wunsch-Dienst) | Eingeschränkt | Zuordnung pro Nutzer eingeschränkt |
| nginx-„Plan B“ für Medien | Nicht verfügbar | Konfiguration wird mit Plex abgelehnt |

### Tonspuren

Plex' Transcoder ignoriert eine in der Anfrage gewählte Tonspur; er nimmt die Spur, die für das **Plex-Konto des Tokens** ausgewählt ist, und zwar beim Start des Streams. Damit jede Person ihre eigene Sprache bekommt, setzt FriendFlix die Auswahl für das Token und startet Streams **einzeln nacheinander**, sodass auch gleichzeitige Zuschauer ihre Spur bekommen. Folgen:

- Starten mehrere Streams im selben Moment, dauert es etwas länger (sie reihen sich kurz ein).
- Die Auswahl deines FriendFlix-Tokens ändert sich ständig. **Nimm nicht das Konto, mit dem du Plex selbst schaust**, sonst springt dessen Tonspur. Nimm ein eigenes Plex-Konto bzw. Token.

## Fehlersuche

| Symptom | Wahrscheinliche Ursache und Lösung |
|---|---|
| Health-Check oder Login schlägt fehl, Log zeigt `401` von Plex | `PLEX_TOKEN` falsch oder widerrufen, oder Server nicht geclaimt. `curl`-Prüfung aus Abschnitt 2 ausführen. |
| `ECONNREFUSED` / Timeouts zu Plex | Gateway oder Backend erreicht `PLEX_URL` nicht. Aus dem Container testen; LAN-Adresse nehmen; Firewalls und Docker-Netze prüfen. |
| Bibliothek oder Titel fehlt | Rolle hat keinen Zugriff auf die Bibliothek, oder Plex hat den Scan nicht beendet. In Plex scannen und den nächsten FriendFlix-Sync abwarten. |
| Kinder-/altersbeschränkte Profile sehen nichts | Titel haben keine oder unbekannte `contentRating`. Siehe [Altersfreigaben](#5-altersfreigaben). |
| Freigaben-Änderung in Plex erscheint nicht | Plex ändert bei Metadaten-Bearbeitung keine Zeitstempel; nächsten Durchlauf abwarten (einige Minuten). |
| Kein „Intro überspringen“ | Keine Marker (braucht Plex Pass) oder noch nicht erkannt. |
| Keine Vorschaubilder beim Spulen | Vorschaubilder in Plex nicht aktiviert/erzeugt, siehe Abschnitt 6. |
| Falsche Tonsprache oder sie wechselt, während andere schauen | Eine andere App nutzt dasselbe Plex-Konto. Eigenes Token nehmen, siehe [Tonspuren](#tonspuren). |
| Stream startet nicht / hängt am Anfang | Der Plex-Transcoder braucht einige Sekunden für das erste Segment; Platz im Transcoder-Temp, CPU-Last und Plex-Logs prüfen. |
| Untertitel fehlen | Es gibt nur Text-Untertitel; bildbasierte (PGS) nicht. |
| FriendFlix-Wiedergabe erscheint nicht in Plex „Aktuell läuft“ | Erwartet: FriendFlix meldet keine Wiedergabe an Plex. |

## Abgleich mit dem Original (für Maintainer)

Dieses Repository ist ein Fork von [LetsManu/friendflix](https://github.com/LetsManu/friendflix). So bleiben Merges klein:

```bash
git remote add upstream https://github.com/LetsManu/friendflix.git   # einmalig
git fetch upstream
git switch main && git merge upstream/main          # regelmäßig, z. B. wöchentlich oder pro Upstream-Release
```

- Plex-Code liegt in `backend/src/plex/` und im Upstream-Adapter des Gateways; gemeinsamer Code bekommt nur die nötigsten Änderungen (die Medienserver-Schnittstelle). Lieber Dateien hinzufügen als Upstream-Dateien ändern.
- Jellyfin-spezifische Doku (`docs/integrations.md`, `docs/operations.md`, `docs/monitoring.md`, `docs/downloads.md`, `docs/discovery.md`, `docs/setup.md`, `docs/authentik.md` and their `docs/de/` twins) bekommt oben nur einen kurzen Hinweis hierher, damit Upstream-Änderungen sauber mergen. Nicht in diesem Fork umschreiben.
- README, `docs/plex.md`, `docs/de/plex.md` und Branding gibt es nur im Fork; Konflikte entstehen höchstens in der README: Fork-Text behalten und sachliche Änderungen des Originals (neue Variablen, Funktionen) nachziehen.
- Nach jedem Merge Lint, Typecheck und Tests laufen lassen, auch die Plex-Tests gegen den Fake-Plex-Server.
- Neue Upstream-Funktionen, die von Jellyfin abhängen, brauchen ein Plex-Pendant oder einen Eintrag in der Vergleichstabelle oben.

## Markenhinweis

Plex is a trademark of Plex, Inc.; this project is not affiliated with or endorsed by Plex. (Plex ist eine Marke von Plex, Inc.; dieses Projekt steht in keiner Verbindung zu Plex und wird von Plex nicht unterstützt.)
