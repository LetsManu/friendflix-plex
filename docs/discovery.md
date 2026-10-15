# Suche & Entdecken – API

> **FriendFlix for Plex (Preview):** Statt des Jellyfin-Tokens gilt bei Plex die Zugriffsprüfung von FriendFlix (Profil, Rolle, Altersgrenze). Einrichtung: [de/plex.md](de/plex.md).

Alle Endpunkte brauchen eine Sitzung, laufen mit dem Jellyfin-Token des aktiven Profils und zeigen deshalb nur Titel, die dieses Profil sehen darf.

## `GET /api/search?q=`

`q`: 2–100 Zeichen. Rate-Limit: 120 pro Minute.

```json
{ "q": "nolan", "titles": [ItemDto], "episodes": [ItemDto],
  "people": [{ "id": "…", "name": "…", "image": true }], "genres": ["…"], "partial": false }
```

- **Ablauf:** Titel (Filme und Serien, max. 24), Folgen (max. 8), Personen (max. 12) und die Genreliste werden parallel abgefragt.
- **Genres:** Es kommen nur Genres zurück, deren Name `q` enthält (max. 6).
- **Jahressuche:** Ist `q` eine Jahreszahl (1900–2100), sind `titles` die Titel dieses Jahres, nach Bewertung sortiert. `episodes` ist dann leer.
- **Teilausfall:** Schlägt eine Teilabfrage fehl, bleibt ihr Abschnitt leer und `partial` ist `true`. Schlagen alle fehl, antwortet der Endpunkt mit `502 {"error":"jellyfin"}`.
- **Personen:** Jellyfin `/Persons` mit `userId` ist ab 10.9 auf die Bibliotheken des Nutzers beschränkt. Eine Personenseite wird zusätzlich nur ausgeliefert, wenn mindestens ein sichtbarer Titel existiert.

## `GET /api/people/:id`

```json
{ "person": { "id": "…", "name": "…", "overview": "…", "birthYear": 1970, "image": true }, "items": [ItemDto] }
```

- `items` enthält bis zu 100 Filme und Serien aus der Bibliothek, die neuesten zuerst.
- `404 {"error":"not_found"}` kommt, wenn die ID keine Person ist oder das Profil keinen Titel mit ihr sehen kann.

## `GET /api/library/items` – neue Filter

| Parameter | Werte | Jellyfin |
|---|---|---|
| `decade` | 1900–2090, durch 10 teilbar | `years=1990,…,1999` |
| `year` | 1900–2100 (hat Vorrang vor `decade`) | `years` |
| `minRating` | 0–10 | `minCommunityRating` |
| `person` | Item-ID (32 hex) | `personIds` |

Ungültige Werte führen zu `400 {"error":"bad_request"}`.

## Sprachfilter: `GET /api/library/languages` und `audio`/`subs`

```json
{ "audio": [{ "code": "deu", "count": 412 }], "subs": [{ "code": "eng", "count": 380 }] }
```

- **Index:** `item_langs` (Filme und Serien) wird von `langIndexTick` aus den MediaStreams aller Filme und Folgen aufgebaut (Admin-Schlüssel, max. alle 12 h; nach einem Start nur, wenn die Tabelle leer ist oder der letzte Lauf (`langidx:last`) über 12 h zurückliegt, nur mit `BACKGROUND_JOBS=true`). Folgen werden je Serie zusammengefasst, `ger`/`fre`/… werden auf `deu`/`fra`/… vereinheitlicht, `und` entfällt. Verschwundene Titel werden nach einem vollständigen Lauf entfernt.
- **`/languages`:** Top 20 je Liste, nach Anzahl absteigend, 10 Minuten gecacht. Die Zahlen gelten für die ganze Bibliothek und enthalten nur Codes, keine Titel.
- **`GET /api/library/items?audio=deu&subs=eng`:** Beide Parameter `^[a-z]{3}$` (sonst 400), einzeln oder zusammen. Die Kandidaten kommen aus dem Index (max. 5000; werden mehr gefunden, enthält die Antwort `capped: true` und die Liste ist nur eine Teilmenge), die Details holt Jellyfin mit dem Token des Profils in Blöcken à 80 IDs (4 parallel, damit die Request-Zeile kurz bleibt). Pro Nutzer sind höchstens 30 solcher Abfragen pro Minute erlaubt (sonst 429 `rate_limited`). Dabei gelten alle anderen Filter (`genre`, `studio`, `decade`/`year`, `minRating`, `person`, `filter`, `types`) und die Sichtbarkeit exakt. Sortierung (`SortName`, `PremiereDate` und `DateCreated` nach Premierendatum, `CommunityRating`, `Random`), `desc`, `start`/`limit` und `total` (Länge der gemergten Liste) berechnet das Backend; die Reihenfolge wird 120 s pro Nutzer und Abfrage gecacht (jeder Seitenabruf verlängert die Frist), damit „Mehr laden“ nicht neu lädt. `DateCreated` sortiert nach dem Hinzufügedatum (Fallback Premierendatum).
- **`GET /api/items/:id`:** enthält zusätzlich `langs: { audio: string[], subs: string[] }`, sofern der Titel (bei Folgen die Serie) im Index steht.

## Watch-Status (je Profil)

`planned` = Merkliste, `dropped` = Tabelle `dropped`, `watching`/`watched` werden aus Jellyfin abgeleitet. Folgen werden auf ihre Serie abgebildet.

- `GET /api/items/:id/status` liefert `{ "status": "none"|"planned"|"watching"|"watched"|"dropped" }` (Rangfolge dropped, planned, abgeleitet). Unsichtbare Titel: 404.
- `PUT /api/items/:id/status` mit `{ "status": "planned"|"dropped"|"none" }` antwortet mit demselben Objekt. `planned` legt den Merklisten-Eintrag an und entfernt `dropped`; `dropped` entfernt die Merkliste und blendet den Titel in „Weiterschauen“ aus; `none` entfernt beides. `POST /api/items/:id/watchlist` beendet ebenfalls „abgebrochen“.
- `GET /api/dropped` liefert `{ "items": [ItemDto] }`, sichtbare Titel, zuletzt abgebrochene zuerst, max. 200.
- Abgebrochene Titel fehlen in `/api/library/resume` und `/api/library/nextup`.

## Freunde-Leiste: `GET /api/items/:id/friends`

```json
{ "friends": [{ "id": "…", "name": "Lea", "stars": 4, "watched": true, "recommended": true }] }
```

- `stars` nur bei Freunden mit `shareRatings` (Standard an), `watched: true` nur bei Freunden mit `shareHistory` (max. 12 geprüft, 5 Minuten gecacht, Fehler lassen das Feld weg), `recommended: true`, wenn der Freund den Titel dir empfohlen hat. Nur Freunde mit mindestens einem Merkmal erscheinen; sortiert nach empfohlen, Sternen, gesehen. Eigene Person und gesperrte Konten fehlen. Limit 60 pro Minute, 404 für unsichtbare Titel.

## „Diese Woche bei uns“: `GET /api/library/trending`

```json
{ "items": [{ "id": "…", "name": "…", "type": "Series", "viewers": 3 }] }
```

- Quelle sind die Wiedergaben der letzten 7 Tage (je Tag und Titel mindestens 300 Sekunden, gesperrte Konten zählen nicht; andere Konten nur mit „Verlauf teilen“ (`shareHistory`), deine eigenen Wiedergaben immer). Folgen werden der Serie zugeordnet; `viewers` ist die Zahl verschiedener Konten, nie Namen.
- Ein Titel erscheint nur mit mindestens 2 Zuschauern oder wenn du selbst dazugehörst. Unsichtbare Titel fehlen (Auflösung mit deinem Token). Sortiert nach `viewers`, dann Sekunden; höchstens 10, 10 Minuten pro Jellyfin-Konto und Betrachter gecacht.
- Items tragen außerdem `lastAdded` (ISO, `DateLastMediaAdded`) für das Badge „Neue Folgen“.

## Reaktionen: `/api/items/:id/reactions`

Nur für Filme und Folgen (Serie: 400 `unsupported_type`, unsichtbar: 404). „Gesehen“ heißt `played` oder mindestens 85 %.

```json
{ "locked": true, "count": 3 }
{ "locked": false, "count": 3, "summary": { "like": 1, "funny": 0, "wow": 1, "sad": 0, "love": 1 },
  "reactions": [{ "name": "Lea", "emoji": "love", "comment": "…", "mine": false, "createdAt": "…" }] }
```

- `GET` liefert vor dem Ansehen höchstens die Anzahl, und die erst ab 2 Reaktionen (eine einzelne verriete, wer es gesehen hat; keine Namen, Emojis oder Kommentare), danach Zusammenfassung und bis zu 100 Reaktionen, neueste zuerst; gesperrte Konten fehlen.
- `PUT { emoji: "like"|"funny"|"wow"|"sad"|"love", comment?: string (getrimmt, max. 280) }` legt die eigene Reaktion an oder ersetzt sie. Ungesehen: 403 `watch_first`. Limit 30 pro Minute. Antwort wie `GET`.
- `DELETE` entfernt die eigene Reaktion, Antwort wie `GET`.
- Kommentare sind reiner Text und dürfen nie als HTML gerendert werden.

## Kuratierte Reihen („Empfohlen von …“)

Admins können bis zu 5 Listen auf der Startseite aller Nutzer hervorheben (Migration 24, `lists.featured_at`).

- `PUT /api/admin/lists/:id/featured` `{featured: boolean}` (Admin, CSRF, Audit `list.feature`/`list.unfeature`): 404 unbekannte Liste, 409 `too_many_featured` ab 5.
- `GET /api/admin/lists` (Admin): `{lists: [{id, name, owner:{id,name}, itemCount, featured}]}`, neueste zuerst, max. 200.
- `GET /api/lists/featured` (jeder angemeldete Nutzer): `{lists: [{id, name, description, owner:{name}, items: ItemDto[]}]}`. Titel werden mit dem Token des Betrachters aufgelöst (versteckte entfallen), max. 24 je Liste, neueste zuerst; Listen ohne sichtbare Titel entfallen.
- `GET /api/lists/:id` ist für Nicht-Mitglieder einer hervorgehobenen Liste lesbar: `list.role = 'guest'`, `members` enthält nur den Besitzer. Alle Schreibzugriffe bleiben Mitgliedern vorbehalten, nicht hervorgehobene Listen liefern weiterhin 404.

## `POST /api/match` – gewichtet

Jeder Treffer trägt `planned`: die Zahl der Teilnehmer (Konten), die den Titel auf der Merkliste eines ihrer Profile haben. Sortiert wird nach `planned`, dann Bewertung, dann Name. Titel, die ein Teilnehmer abgebrochen (`dropped`, jedes Profil) oder mit Daumen runter bewertet hat, entfallen. Wer geplant hat, wird nicht verraten.

## Marken-Hubs, Extras, Simulcast, Kommentare

- **Marken-Hubs:** `GET /api/hubs` (sichtbare Hubs mit Kachelbild), `GET /api/hubs/:id` und `/api/hubs/:id/items` (Reihen Neu, Beliebt, Filme, Serien, A–Z). Quelle ist ein Jellyfin-Studio, eine Sammlung, ein Tag oder ein Genre; der Admin pflegt sie unter `/admin/hubs` (bis zu 8, Vorschläge aus der Bibliothek). Inhalte laufen immer über den Jellyfin-Zugang des Profils.
- **Extras:** `GET /api/items/:id/extras/all` – lokale Trailer und Bonusmaterial; der Tab fehlt, wenn es nichts gibt.
- **Weitere „Weil du … gesehen hast“-Reihen:** `GET /api/library/because-more` – bis zu drei Reihen zu verschiedenen zuletzt gesehenen Titeln, ohne Doppelte und ohne Weiterschauen-Titel.
- **Serien-Sprachwahl:** `GET/PUT/DELETE /api/series/:id/langpref` (je Profil; eine Folgen-ID zählt für ihre Serie). `?anime=1` liefert zusätzlich `anime` für die Einstellung „Anime: Originalton mit Untertiteln“ (`animeOriginal` in `/api/prefs`): ohne eigene Serienwahl startet ein Anime auf Japanisch mit Untertiteln in der UI-Sprache, sofern es eine japanische Tonspur gibt.
- **Simulcast:** `GET /api/simulcast[?anime=1]` – laufende Serien mit Folgen in den letzten/nächsten vier Wochen, nach Wochentag und Season.
- **Folgen-Kommentare:** `GET/POST /api/items/:id/comments`, `DELETE /api/comments/:id` (Autor oder Admin). Sichtbar für alle Konten der Instanz außer Gästen – FriendFlix kennt keine eigene Freundesliste, alle eingeladenen Konten sind „Freunde“ (wie bei `/api/friends`). Wer die Folge noch nicht gesehen hat, bekommt alle fremden Kommentare ohne Text, bis `?reveal=1` sie anfordert. Löschen darf der Autor oder ein Admin im Hauptprofil.

## Block 17: Frische-Labels, „Bald nicht mehr verfügbar“, Qualität

- **Frische-Labels** (`POST /api/discover/badges` mit bis zu 80 Ids, `GET /api/items/:id/facts`): höchstens ein Label je Karte, Priorität Neue Serie > Staffelfinale > Neue Staffel > Neue Folge; Filme „Neu“ (14 Tage). Nur Titel, die der Betrachter sehen darf, bekommen eine Antwort. Serien-Labels werden 15 min bibliotheksweit gecacht; je Anfrage werden höchstens 12 noch nicht gecachte Serien berechnet (je zwei Medienserver-Aufrufe), der Rest bekommt sein Label bei einer späteren Anfrage. Beide Routen sind auf 60 Anfragen/min je Sitzung begrenzt (`/api/library/quality` ebenso).
- **Heuristik „Staffelfinale“** (bewusst einfach, `seriesLabel` in `backend/src/fresh.ts`): die letzte vorhandene Folge der neuesten Staffel kam in den letzten 7 Tagen, die Staffel begann früher (sonst „Neue Staffel“), die Staffel hat mindestens 3 Folgen, es sind keine angekündigten (noch nicht ausgestrahlten) Folgen mehr eingetragen und die Serie ist **nicht** „Continuing“. Laufende Serien werden über `libraryContinuingSeriesIds` mit dem Admin-Schlüssel vollständig (seitenweise) ermittelt, damit eingeschränkte Profile oder große Bibliotheken kein falsches „Staffelfinale“ erzeugen. Eine Serie, deren Status der Medienserver nicht pflegt, gilt als beendet; ist der Status unbekannt (Fehler), wird nie ein Finale behauptet.
- **„Bald nicht mehr verfügbar“:** Tage werden in der Zeitzone der Instanz gezählt (`TZ` des Backends, Compose-Standard `Europe/Vienna`; ohne `TZ` UTC), nicht in der der Datenbank. Der stündliche Job (Aufräumen abgelaufener Daten, Hinweise 7 Tage und 1 Tag vorher) läuft wie die anderen Hintergrundjobs nur mit `BACKGROUND_JOBS=true`.
- **Qualitätsfilter** (`GET /api/library/quality`): Kandidaten aus `item_quality`, Details und Sichtbarkeit vom Medienserver mit der Identität des Betrachters (bis zu 4 Blöcke à 80 parallel). Die sortierte Id-Liste des Betrachters wird 3 min je Medienserver-Identität und Filter gecacht (Kinderprofile haben eine eigene Identität); weitere Seiten fragen nur noch die Titel der Seite ab.

## Block 17: Besetzung & Infos, Szenen, „Die Geschichte bisher“

- **`GET /api/items/:id/castinfo`** (Player: Taste <kbd>I</kbd> für den kurzen Blick, „Alle Infos“ für das Fenster): `{ item, cast, guests, directors, writers, creators, studios, genres, tags }`. Bei Folgen gelten die Stammbesetzung der Serie als `cast` und alle nur auf der Folge Genannten als `guests`; Regie und Drehbuch kommen von der Folge, sonst von der Serie, `creators` von der Serie. Gekürzt auf 40 Darsteller, 30 Gaststars und je 8 Crew-Einträge. Ohne `credits()` im Medienserver (siehe [architecture.md](architecture.md)) fällt die Route auf `people()` plus Tags zurück. Jeder Aufruf prüft die Sichtbarkeit mit der Identität des Betrachters (404 für unsichtbare Titel); die Daten des Medienservers werden 5 min je Identität gecacht. Ein Tipp auf eine Person öffnet ihre Titel aus der Bibliothek (`GET /api/people/:id`, siehe oben).
- **`GET /api/items/:id/chapters`** (Fenster „Szenen“, Kapitelmarken auf der Zeitleiste): `{ supported, chapters: [{ start, name, image? }] }`. `supported: false`, wenn der Medienserver keine Kapitel liefert (`capabilities.chapters`); der Player zeigt dann weder Marken noch das Fenster. Die Kapitelbilder laufen über das Gateway (`/media/Items/<id>/Images/Chapter/<n>`), fehlt eines, nimmt die Oberfläche ein Trickplay-Bild.
- **`GET /api/items/:id/story`** („Die Geschichte bisher“ auf der Serienseite): `{ story: null }` für Filme und wenn nichts zutrifft, sonst `{ reason: 'newSeason' | 'longBreak', weeks?, season?, episode, next }`. Sie erscheint, wenn die nächste ungesehene Folge die erste einer neuen Staffel ist oder die letzte Wiedergabe mindestens 6 Wochen (`STORY_BREAK_WEEKS`) zurückliegt, und besteht nur aus Metadaten: der Beschreibung der zuletzt vollständig gesehenen Staffel und der Beschreibung der zuletzt gesehenen Folge – nie Folgen, die du noch nicht gesehen hast. Ausgeblendet wird die Karte im Browser (`localStorage`).
- **Klang im Player** und **Ruhiger Modus** sind Profil-Einstellungen und stehen in [personal.md](personal.md).

## Empfehlungen messen: `scripts/reco-eval.mjs` und `POST /api/reco/events`

Schritt R0 der Empfehlungs-Engine v2 (Spezifikation 4.7): erst messen, dann bauen. Der Auswertungslauf ist offline und ändert nichts.

**Aufruf**

```
node scripts/reco-eval.mjs                  # mitgelieferte Testdaten (scripts/fixtures/reco-eval.json)
node scripts/reco-eval.mjs --data x.json    # eigener Datensatz
DATABASE_URL=… node scripts/reco-eval.mjs --db [--items items.json] [--similar similar.json]
```

Weitere Schalter: `--engines popularity,v1,cooccurrence`, `--exclude-seen` (schon gesehene Titel bei allen Engines entfernen), `--json`, `--min-profiles N` (Standard 5: weniger ausgewertete Profile werden nicht ausgegeben, ein Mittelwert über eine Person wäre keiner), `--plugin datei.mjs` (Modul mit `export const engines = { name: fabrik }`, so kommt v2 später dazu). Der Test läuft mit `npm run test:scripts`.

**Verfahren (leave-last-out).** Je Profil mit mindestens 10 Interaktionen wird die letzte zurückgehalten; jede Engine sieht die früheren und liefert bis zu 50 Titel, die Kennzahlen betrachten die ersten 10. Kinderprofile bleiben ganz draußen (auch beim Training: sie speisen keine profilübergreifenden Signale). Gedruckt werden nur Aggregate, nie ein Titel, eine ID oder ein Profil.

| Kennzahl | Bedeutung |
|---|---|
| HitRate@10, NDCG@10, MRR | Treffer in den ersten 10; NDCG mit einem gesuchten Titel = 1/log2(Rang+1); MRR über die ersten 50 |
| Coverage | verschiedene empfohlene Titel / Katalog |
| Diversity (ILD) | mittlere Genre-Unähnlichkeit (1 − Jaccard) der Titel einer Liste; leer ohne Genre-Daten |
| Already seen | Anteil schon gesehener Titel in den Listen |
| Mid-pop. share of hits | Anteil der Treffer auf Titel der mittleren Beliebtheitsstufe (nach Trainingsdaten: oberste 20 % Kopf, unterste 50 % Rest, dazwischen Mitte) |
| New-title hit rate | Trefferquote, wenn der gesuchte Titel sonst niemand gesehen hat (Kaltstart) |
| Transition accuracy | der echte nächste Titel nach dem zuletzt gesehenen steht in den ersten 10 der Fläche „was kommt danach“ |

**Engines hinter einer Schnittstelle** `{ name, fit(train, daten), recommend({ surface: 'home' | 'next', history, seed, k, disliked }) }`:

- `popularity`: meistgesehene Titel (mindestens 2 Profile), ohne schon Gesehenes.
- `v1`: bildet `libraryBecause` nach: Seed ist die letzte Daumen-hoch-Bewertung, sonst der zuletzt gesehene Titel; Kandidaten sind die `similar()`-Antwort des Medienservers in deren Reihenfolge, ohne Daumen-runter, gesehene Titel bleiben drin (wie heute). Offline gibt es keinen Medienserver. Es gilt: steht der Seed im Datensatz unter `similar` (aufgezeichnete Antworten, 30 Titel), wird diese Liste genommen; sonst eine Nachbildung über die Titelmerkmale (Genre-Überlappung, dann Nähe im Erscheinungsjahr, 30 Titel). Aus der Datenbank allein gibt es weder Merkmale noch `similar()`; dafür `--items` (`[{id, genres, year}]`) und `--similar` (`{seedId: [ids]}`, einmal aus dem laufenden System aufgezeichnet) übergeben, sonst bleibt v1 leer und die Diversität `n/a`.
- `cooccurrence`: Item-Item-Kosinus über „vom selben Profil gesehen“, nur Paare aus mindestens 2 Profilen (Aggregat-Regel aus 4.8). `home`: gesamter Verlauf, neuere Titel zählen mehr; `next`: Titel, die in anderen Profilen direkt auf den Seed folgten, danach Co-Occurrence.

**Datenbank (`--db`).** Eine einzige Transaktion `READ ONLY`, nur Lesen, die Verbindung wird nie ausgegeben. Positive Interaktionen: `play_seconds` (mindestens 120 s je Titel, `--min-seconds`), Daumen hoch/geliebt, Bewertungen ab 4 Sternen; Daumen runter zählt nicht als Interaktion. Grenzen: `play_seconds` kennt nur das Konto, nicht das Profil (die Wiedergaben zählen für das Hauptprofil), und nur den Tag, nicht die Uhrzeit; Folgen sind eigene Titel. Der Katalog ist die Menge aller Titel mit Interaktionen. Der Wiedergabe-Verlauf des Medienservers wird nicht gelesen.

**Offene Punkte aus der Spezifikation.** Matrixfaktorisierung (ALS) und Replay mit Propensities kommen mit der Exploration (R3b); `shadow` mit R4.

### Online-Zähler

`POST /api/reco/events` (Anmeldung und CSRF-Token nötig, 60 Aufrufe pro Minute, auch für Kinderprofile, weil nur Zahlen ankommen):

```json
{ "events": [{ "row": "because", "engine": "v1", "impressions": 1, "clicks": 2, "dismisses": 0 }] }
```

Antwort `204`. `row` ist eine feste Liste (`because`, `because_more`, `top_picks`, `popular`, `friends`, `postplay`), `engine` ist `v1` oder `v2`; alles andere wird mit `400` abgelehnt, die Labels bleiben also begrenzt. Es werden weder Titel noch IDs, Positionen oder Profile übertragen oder gespeichert. Prometheus: `friendflix_reco_impressions_total`, `friendflix_reco_clicks_total`, `friendflix_reco_dismiss_total` und `friendflix_reco_plays_total`, jeweils `{row,engine}`. Click-through-Rate: `sum(increase(friendflix_reco_clicks_total[7d])) by (engine) / sum(increase(friendflix_reco_impressions_total[7d])) by (engine)`.

Die Startseite meldet je „Weil du … geschaut hast“-Zeile (`because`, `because_more`, Engine `v1`) eine Einblendung, sobald die Hälfte der Zeile zu sehen ist, und jeden Klick auf einen Titel; die Zahlen werden gesammelt und alle 4 Sekunden oder beim Verlassen der Seite gesendet. `plays` zählt der Server selbst, sobald eine Wiedergabe einer Empfehlung zugeordnet werden kann, und `dismisses` kommen mit den Schaltflächen „nicht interessiert“: beides gehört zu R4.

## Kinderprofile

Ein Kinderprofil (`kids`, Altersgrenze 0/6/12 als Jellyfin-`MaxParentalRating`, Titel ohne Freigabe ausgeblendet) erhält auf alle sozialen und kontoweiten Routen `403 kids_profile` (`requireGrownUp` in `backend/src/kids.ts`): Reaktionen, Freunde-Leiste, Bewertungen, Listen, Abstimmungen, Kommentare, Watch-Party (REST und WebSocket, Schließcode 4403), Freunde/Matcher/Empfehlungen, „Freunde haben bewertet“, „Läuft gerade“, Wünsche (Wunsch-Dienst), Statistiken, Wochenrückblick, Benachrichtigungen, Web-Push, Erinnerungen, „Diese Woche bei uns“ und Geräteliste. Inhalte (Titel, Suche, Wiedergabe, Hubs, Extras, Downloads, Simulcast, Serien-Sprachwahl) bleiben erlaubt. Ein Fernseher, der aus einem Kinderprofil gekoppelt wird, ist fest an dieses Profil gebunden (`devices.kids_profile_id`); auf solchen Geräten wird „PIN vergessen?“ abgelehnt. Ändert der Inhaber Kinder-Flag oder Altersgrenze, verwirft der Server die Caches dieses Profils (`policyChanged` in `backend/src/hooks.ts`).

## Web

- **`/search`:** Die Abschnitte heißen Personen, Genres, Filme & Serien und Folgen.
  - Der Zustand steckt in `?q=`.
  - Die letzten 8 Suchen werden lokal im Browser gespeichert und lassen sich löschen.
  - `/` oder Strg/⌘+K springt von überall in die Suche.
- **`/person/<id>`:** Filmografie mit Filter Alle/Filme/Serien. „In Filmen stöbern“ öffnet `/browse/movies?person=<id>`.
- **`/browse/movies|series`:** Filter für Genre, Jahrzehnt, Bewertung, Sortierung und Status.
  - Aktive Filter erscheinen als Chips mit ×.
  - Alle Filter stehen in der URL und lassen sich teilen.
