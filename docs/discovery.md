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

## 1.1: „Was als Nächstes?“ – Bildschirm nach dem Ende (`GET /api/items/:id/postplay`)

Sitzung nötig, je Profil, mit dem Token des aktiven Profils (Kinder-Altersgrenze und Bibliotheken gelten); nicht sichtbare oder unbekannte Titel `404`, falsche IDs `400`. Rate-Limit `perSession(60)` (60 pro Minute und Sitzung). Mit `POSTPLAY_ENABLED=false` antwortet der Endpunkt `404 {"error":"disabled"}`, `/api/me` meldet `features.postplay: false` und die Web-App zeigt weder Karte noch Bildschirm.

```json
{ "state": "next" | "movie_end" | "series_finished" | "caught_up" | "gap",
  "current": ItemDto, "next": ItemDto | null, "nextAirDate": "2026-10-21" | null, "sequel": ItemDto | null,
  "canWish": true, "remind": { "episodeId": "…" } | null, "suggestions": true,
  "rows": [{ "kind": "continuation|universe|because|friends|taste", "title": "…",
             "reason": { "seed": { "id": "…", "name": "…" }, "traits": ["genre:…", "collection:…", "hub:…", "tag:…"] },
             "items": [ItemDto], "wish": { "mediaType": "tv", "tmdbId": 1396, "quota": { "limit": 5, "used": 3, "remaining": 2, "resetsAt": "…" } } }],
  "hero": ItemDto | null }
```

- **Zustände:**
  - `next`: Eine ungesehene Fortsetzung ist da – die nächste *verfügbare* Folge (`nextEpisode`, angekündigte Folgen zählen nicht) oder der nächste ungesehene Teil einer Filmsammlung (`itemCollections`). Bei Folgen bleibt im Player der bisherige Countdown; der Bildschirm erscheint dort nicht.
  - `gap`: Keine nächste Folge, aber eine frühere verfügbare Folge ist noch ungesehen (Specials ausgenommen) → „Folge N ist noch ungesehen“, `next` ist diese Folge.
  - `series_finished`: Letzte Folge einer Serie, deren Status *sicher* „beendet“ ist. Den Status liefert der optionale Medienserver-Hook `seriesStatus()` (Jellyfin: `Status` = `Ended`). Fehlt der Hook oder ist der Status unbekannt, zählt nur ein positives „läuft noch“ aus der Liste in `fresh.ts` – eine Serie wird **nie** „beendet“ genannt, wenn der Status unbekannt ist (gleiche Regel wie beim „Staffelfinale“). `sequel` ist ein späterer Teil einer Sammlung, zu der die Serie gehört.
  - `caught_up`: Letzte verfügbare Folge einer laufenden Serie (oder einer mit unbekanntem Status). `nextAirDate` und `remind` kommen von der angekündigten nächsten Folge bzw. `upcoming()`; „Erinnere mich“ nutzt die bestehenden Erinnerungen (`POST /api/reminders {episodeId}`), nicht auf Kinderprofilen.
  - `movie_end`: Film ohne ungesehenen späteren Teil.
- **Reihen** in dieser Reihenfolge, leere fallen weg, kein Titel kommt zweimal vor:
  1. `continuation`: nächster Teil, Fortsetzung oder die übersprungene Folge. Fehlt bei einer beendeten Serie eine Staffel (Wunsch-Dienst meldet „teilweise verfügbar“), trägt die Reihe `wish` mit dem Monatskontingent; gewünscht wird über den bestehenden Weg `POST /api/requests`.
  2. *(R3: `transition`, „Was andere nach X schauen“ – Erweiterungspunkt `ROW_SOURCES` in `backend/src/postplay.ts`, noch nicht aktiv)* und `universe`: die anderen Teile der Sammlung, sonst der erste passende Marken-Hub (Studio/Tag/Sammlung), sonst das erste Tag (ab 4 Titeln).
  3. `because`: Jellyfins `similar()` mit dem gerade beendeten Titel als Ausgangspunkt (bei Folgen die Serie); `reason.seed` ist dieser Titel.
  4. `friends`: das bestehende `friendsRatedFor` (Opt-in `shareRatings`, ≥ 4 Sterne, 90 Tage). Nie auf Kinderprofilen.
  5. `taste`: die profilbasierten Reihen der bestehenden Engine (`libraryBecause` + `libraryBecauseMore`, abwechselnd gemischt).
- **Filter:** Nie der Titel selbst oder seine Serie, nie Gesehenes oder komplett gesehene Serien, nie „Abgebrochen“ (`dropped`) oder Daumen runter des Profils. Höchstens jeder dritte Titel einer Reihe stammt aus der aktuellen Season (Premiere in den letzten 91 Tagen; auf jedem dritten Platz), damit nicht nur Simulcast-Hits erscheinen.
- **Hero:** Fortsetzung bzw. nächster Teil, sonst aus den ersten 8 Titeln der `because`-Reihe der, der auch zur `taste`-Reihe des Profils passt, dann mit Bild, dann eine je Profil stabile Reihenfolge – nicht jedes Profil bekommt denselben Tipp.
- **Spoilerschutz:** Ist er an, fehlt die Beschreibung ungesehener Folgen (`current`, `next`, Reihen); die Web-App blendet auch deren Vorschaubild aus.
- **Einstellung je Profil** „Vorschläge nach der letzten Folge zeigen“ (`postplay` in `GET/PUT /api/prefs`, Standard an). Aus: `suggestions: false`, nur noch die Reihe `continuation`, kein Hero.
- **Cache:** 60 s je Profil + Titel + User-Data-Version des Medienservers + Home-Generation; `bumpHome()` (Daumen, Liste, Status …) verwirft ihn sofort.

### Zähler: `POST /api/postplay/event`

Body `{"type":"shown","state":…}`, `{"type":"click"|"play","row":…}` oder `{"type":"dismiss"}` (nur die festen Werte oben, sonst `400`); Antwort `204`, Rate-Limit `perSession(120)`. Es entstehen nur Summen ohne Titel, Nutzer oder IDs: `friendflix_postplay_shown_total{state}`, `friendflix_postplay_click_total{row_kind}`, `friendflix_postplay_play_total{row_kind}`, `friendflix_postplay_dismiss_total`.

### Web

- **Karte „Fertig? Sieh dir an, was als Nächstes kommt“:** klein und nicht blockierend, ab dem Abspann – Outro-Segment des Medienservers, sonst das letzte Kapitel (wenn es in den letzten 20 % beginnt), sonst 95 % der Laufzeit. Nur ohne nächste Folge (sonst bleibt der Countdown) und nicht, während ein Fernseher spielt. Sie lädt die Antwort schon vor.
- **Bildschirm:** Endet der Titel (oder auf Klick auf die Karte), legt sich der Bildschirm über den Player (Vollbild wird verlassen). Oben links der gerade gesehene Titel und die Überschrift (`aria-live`), dann der nächste Schritt (Abspielen, Zurückspringen, Erinnere mich, Wunsch mit Kontingent), ein Hero mit *Abspielen*, *Auf die Merkliste*, *Kein Interesse* (mit *Rückgängig*, inline) und *Details*, „Bewerten“ für den gerade gesehenen Titel, dann die Reihen mit ihrem Grund. Es startet **nie** etwas von selbst. Esc bzw. Zurück (TV) schließt den Bildschirm; man bleibt beim Titel. Auch die Zurück-Taste des Browsers bzw. Handys schließt ihn: Beim Öffnen legt der Bildschirm einen eigenen Verlaufseintrag an (SvelteKit `pushState`), Zurück nimmt ihn wieder weg, und wer ihn anders schließt, hinterlässt keinen Eintrag. Solange er offen ist, ist der verdeckte Player `inert` (keine Fokusfalle). *Kein Interesse* → *Rückgängig* stellt den Daumen wieder her, den der Titel vorher hatte (`PUT /api/items/:id/thumb` antwortet mit `previous`). Die Sichtbarkeit wird bei jeder Anfrage vor dem 60-s-Cache geprüft: Ein Titel, den das Profil nicht mehr sehen darf, ergibt 404, auch wenn der Cache noch warm ist.
- **`/postplay/<id>`:** derselbe Bildschirm ohne Player (TV, Handy, Direktlink, Detailseite nach der letzten Folge).
- **Ruhemodus und reduzierte Bewegung:** keine Einblendung, keine Übergänge; Trailer, Vorschauclips oder Ton gibt es auf dem Bildschirm ohnehin nicht. **TV-Modus:** große Schrift, Fokus mit den Pfeiltasten (`data-nav`/`data-scope`), der erste sinnvolle Knopf hat den Fokus.

## Empfehlungen messen: `scripts/reco-eval.mjs` und `POST /api/reco/events`

Schritt R0 der Empfehlungs-Engine v2 (Spezifikation 4.7): erst messen, dann bauen. Der Auswertungslauf ist offline und ändert nichts.

**Aufruf**

```
node scripts/reco-eval.mjs                  # mitgelieferte Testdaten (scripts/fixtures/reco-eval.json)
node scripts/reco-eval.mjs --data x.json    # eigener Datensatz
DATABASE_URL=… node scripts/reco-eval.mjs --db [--items items.json] [--similar similar.json]
```

Weitere Schalter: `--engines popularity,v1,cooccurrence`, `--exclude-seen` (schon gesehene Titel bei allen Engines entfernen), `--json`, `--min-profiles N` (Standard 5: weniger ausgewertete Profile werden nicht ausgegeben, ein Mittelwert über eine Person wäre keiner), `--plugin datei.mjs` (Modul mit `export const engines = { name: fabrik }`, weitere Engines kommen so dazu; v2 ist seit R2 eingebaut, siehe unten). Der Test läuft mit `npm run test:scripts`.

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

**Offene Punkte aus der Spezifikation.** Matrixfaktorisierung (ALS) ist nicht gebaut (zu dünne Daten für eine Freundesgruppe, Begründung in der Spezifikation 2.2). Replay mit Propensities und die Ablationstabelle gibt es seit R3/R3b (unten). `shadow` gibt es seit R2.

### Online-Zähler

`POST /api/reco/events` (Anmeldung und CSRF-Token nötig, 60 Aufrufe pro Minute, auch für Kinderprofile, weil nur Zahlen ankommen):

```json
{ "events": [{ "row": "because", "engine": "v1", "impressions": 1, "clicks": 2, "dismisses": 0 }] }
```

Antwort `204`. `row` ist eine feste Liste (`ROW_KINDS` in `reco/rows.ts`: `continue`, `because`, `because_more`, `top_picks`, `popular`, `friends`, `postplay`, `new`, `leaving`, `transition`, `universe`, `detail`), `engine` ist `v1` oder `v2`; alles andere wird mit `400` abgelehnt, die Labels bleiben also begrenzt. Es werden weder Titel noch IDs, Positionen oder Profile übertragen oder gespeichert. Prometheus: `friendflix_reco_impressions_total`, `friendflix_reco_clicks_total`, `friendflix_reco_dismiss_total` und `friendflix_reco_plays_total`, jeweils `{row,engine}`. Click-through-Rate: `sum(increase(friendflix_reco_clicks_total[7d])) by (engine) / sum(increase(friendflix_reco_impressions_total[7d])) by (engine)`.

Die Startseite meldet je „Weil du … geschaut hast“-Zeile (`because`, `because_more`, Engine `v1`) eine Einblendung, sobald die Hälfte der Zeile zu sehen ist, und jeden Klick auf einen Titel; die Zahlen werden gesammelt und alle 4 Sekunden oder beim Verlassen der Seite gesendet. `plays` zählt der Server selbst, sobald eine Wiedergabe einer Empfehlung zugeordnet werden kann, und `dismisses` kommen mit den Schaltflächen „nicht interessiert“: beides gehört zu R4.

## Empfehlungs-Index (`item_features`, R1)

Vorbereitung der Empfehlungs-Engine v2 (`backend/src/reco/`). Der Index liest nur Bibliotheks-Metadaten, braucht keine Wiedergabedaten und ändert für sich keine Empfehlung: „Weil du … gesehen hast“ und die Reihen laufen weiter über `similar()` des Medienservers, solange `RECO_ENGINE=v1` gilt (Standard). Die Engine v2 (R2, unten) liest den Index.

- **Inhalt je Film und Serie** (Folgen werden zur Serie gerechnet, sie haben keine eigene Zeile): `genres`, `tags`, `studios` (kleingeschrieben, ohne Dubletten), `people` (Ids der 8 wichtigsten Personen: bis zu je 2 Regie, Urheber und Drehbuch, dann Darsteller in Reihenfolge der Besetzung), `year`, `runtime_min`, `community_rating`, `critic_rating`, `original_language`, `countries`, `collection_id` (Sammlung/Box Set), `series_status` (`continuing`/`ended`), `overview_terms` und `updated_at`. `original_language` bleibt bei Jellyfin leer, weil der Server sie nicht meldet. Keine Pfade, URLs, Tokens, Titel oder Nutzerdaten.
- **Quelle:** das optionale `MediaServer.libraryFeatures?(start, limit, { ids?, savedSince? })` mit der Fähigkeit `capabilities.libraryFeatures` (siehe [architecture.md](architecture.md)). Jellyfin liefert Seiten zu 200 (`sortBy=SortName,Id`, Admin-Schlüssel) und benutzt dieselben Abbildungen wie `credits()` und `itemAbout()`; es braucht also keinen Aufruf je Titel. Die Sammlung kommt aus dem bibliotheksweiten Box-Set-Index (1 h gecacht); fällt er aus, fehlt nur `collection_id`. Ohne die Methode bleibt der Job untätig.
- **TF-IDF:** Beschreibung und Slogan werden in Wörter zerlegt (Buchstaben und Ziffern jeder Schrift, ohne Stoppwörter, ohne Wörter unter 3 Zeichen und reine Zahlen). Gewicht je Wort = `(1 + ln Anzahl) · idf`, mit `idf = ln((N + 1) / (df + 1)) + 1`; behalten werden die 40 stärksten Wörter, L2-normiert (das Skalarprodukt ist der Kosinus). Ab 20 Titeln fallen Wörter heraus, die nur ein Titel enthält, denn sie können mit keinem anderen übereinstimmen. Ohne Leerzeichen geschriebene Sprachen (Chinesisch, Japanisch) ergeben lange Wörter und taugen kaum.
- **IDF** je Wert von Genre, Tag, Studio und Person (`item_feature_idf`, `kind` = `genre|tag|studio|person|term`): ein seltener Regisseur wiegt mehr als das Genre „Drama“. Zahlen (Jahr, Laufzeit, beide Bewertungen) stehen mit Mittelwert und Standardabweichung in `item_feature_stats`, damit R2 sie standardisieren kann (`zscore` in `reco/tfidf.ts`).
- **Gewichte** der Feldgruppen: `RECO_W_GENRES` (1), `RECO_W_TAGS` (0,6), `RECO_W_STUDIOS` (0,4), `RECO_W_PEOPLE` (0,8), `RECO_W_TEXT` (1), `RECO_W_NUMERIC` (0,3), `RECO_W_COLLECTION` (1,5); 0 bis 10, `0` schaltet die Gruppe ab. Der Index speichert die Rohwerte, die Gewichte greifen erst beim Lesen (`recoWeights` in `reco/weights.ts`); eine Änderung braucht also keinen neuen Aufbau.
- **Job** (`reco/indexJob.ts`, nur mit `BACKGROUND_JOBS=true`, nach dem Muster des Hygiene-Scans): Prüfung jede Minute ab 90 s nach dem Start.
  - **Vollständiger Durchlauf** beim ersten Start, danach nachts um 3:00 (Serverzeit), sobald der letzte einen Tag alt ist, und spätestens nach 36 h. Nur ein vollständiger Durchlauf löscht Zeilen verschwundener Titel und berechnet alle Wort- und IDF-Werte neu.
  - **Inkrementell:** `itemAdded` auf dem `media.event`-Bus (bei einer Folge ihre Serie) merkt die Id vor; 30 s nach der letzten Meldung holt ein Durchlauf genau diese Titel. Neue Titel funktionieren sofort, ihre Wörter nutzen die gespeicherten Dokumenthäufigkeiten. `itemRemoved` löscht die Zeile sofort.
  - **Sperre** über `reco:idx:running` in Redis (`setnx`, 5 min, jede Minute erneuert), damit nie zwei Replikate gleichzeitig laufen. **Backoff** nach einem Fehler: 5 min, verdoppelt bis höchstens 6 h; der Fehler erscheint im Fehlerprotokoll nur als Jobname `reco-index`, nie mit Meldung oder URL.
- **Sichtbarkeit:** *Admin → Status* zeigt die Kachel „Empfehlungs-Index“ (Anzahl und Alter; „Noch nicht aufgebaut“, „Wird aufgebaut …“ oder „Vom Medienserver nicht unterstützt“), `GET /api/admin/summary` das Feld `recoIndex { supported, running, items, updatedAt }`. Metriken: `friendflix_reco_index_items`, `friendflix_reco_index_age_seconds` und `friendflix_reco_index_runs_total{mode="full|incremental",result="ok|error"}` (nur diese festen Werte als Labels, keine Titel oder Ids).
- **Datenschutz:** Der Index enthält ausschließlich Bibliotheksdaten und gilt für alle Profile gleich. Wer welche Titel sehen darf, entscheidet weiterhin der Medienserver mit der Identität des Betrachters; Kinderprofile sind davon nicht berührt.

## Empfehlungs-Engine v2: Geschmacksprofil und Bewertung (R2, Shadow-Modus)

Code in `backend/src/reco/`. Standard bleibt `RECO_ENGINE=v1`: Es ändert sich nichts, bis jemand umschaltet.

**`RECO_ENGINE`**

| Wert | Wirkung |
|---|---|
| `v1` (Standard) | „Weil du … gesehen hast“ wie bisher: `similar()` des Medienservers minus Daumen-runter. v2 läuft nicht. |
| `shadow` | Die Antwort ist **genau die von v1**. Daneben rechnet v2 mit demselben Seed (nicht abgewartet, höchstens einmal je Profil, Nutzerdaten-Version und Seed in 10 Minuten, Redis-Schlüssel `reco:shadow:…`) und hält nur Zahlen fest. Ein Fehler in v2 wird gezählt und bleibt für den Zuschauer unsichtbar. |
| `v2` | Alles, was der Abschnitt [Rollout (R4)](#empfehlungs-engine-v2-rollout-r4) nennt, kommt aus `recommend()`; fällt v2 aus, antwortet v1. Der Standard bleibt `v1`, bis jemand (nach dem Tor der Spezifikation) umschaltet. |

**Shadow-Metriken** (Labels sind begrenzt: `surface` ist eine der fünf Flächen, `result` ist `ok|error`; nie ein Titel, eine Id, ein Profil oder ein Nutzer):

- `friendflix_reco_shadow_runs_total{surface,result}`: Vergleiche.
- `friendflix_reco_shadow_overlap{surface}` (Histogramm, 0 bis 1): Anteil der v1-Top-10, den v2 auch in seinen Top 10 hat.
- `friendflix_reco_shadow_score_delta{surface}` (Histogramm): mittlerer v2-Score der v2-Top-10 minus mittlerer v2-Score der v1-Top-10 (nur Titel, die v2 als Kandidat bewertet hat). Positiv: v2 hält seine eigene Liste für besser.

**Geschmacksprofil** (`profile.ts`, je Profil)

| Signal | Startgewicht | Quelle |
|---|---|---|
| Daumen 2 / 1 | +3,0 / +1,5 | `thumbs` des Profils |
| Sterne 5 / 4 / 3 / 2 / 1 | +2,5 / +1,5 / 0 / −1 / −2 | `ratings` (nur beim Hauptprofil) |
| Film fertig gesehen; Serie mit Abschlussquote r | +1,0; +2,0·r | Verlauf des Profils beim Medienserver; r = gesehene / (gesehene + ungesehene Folgen) |
| Rewatch; Favorit | +1,0; +1,0 | Rewatch: Film an mindestens 2 Tagen und insgesamt mindestens 1,6 Laufzeiten gesehen (`play_seconds`, nur Hauptprofil); Favorit aus dem Medienserver (ohne Datum: als 60 Tage alt gerechnet) |
| Merkliste | +0,5 | `watchlist` |
| Früh abgebrochen (unter 15 % und 14 Tage nicht zurück); `dropped` | −1,0; −2,0 | |
| Daumen −1 | −4,0 | zusätzlich harter Filter |

- **Zeitabfall:** `Gewicht · 0,5^(Alter in Tagen / 120)` (`RECO_HALF_LIFE_DAYS`). Die Signale eines Titels werden nach dem Abfall addiert; die Summe sortiert den Titel in den positiven oder den negativen Vektor (sein Merkmalsvektor, mit |Summe| gewichtet). Beide Vektoren werden L2-normiert; ein Titel ohne Eintrag im Index zählt als Interaktion, trägt aber nichts bei.
- **Kaltstart:** weniger als 5 Titel mit Gewicht (3-Sterne-Wertungen und doppelte Signale zählen nicht extra) = `cold`. Dann gibt es keine Nachbarn aus dem Profil, die Kandidaten stammen aus `similar()` und, ohne Seed, aus den bestbewerteten Titeln der Bibliothek (Quelle `prior`); die Inhaltsnähe ist 0.
- **Abgeleitet:** Anime-Anteil, Laufzeitband (kurz unter 40 Minuten, mittel unter 100, lang), die fünf stärksten Genres, Rewatch-Anteil (gebraucht für die Strafe „schon gesehen“). Daneben seit R3: Sprachanteile, Abbruchquote bei Serien, Tageszeit-Verteilung der Genres und die stärksten Titel („Anker“), siehe unten.
- **Cache:** Redis `reco:taste:<profil>:<nutzerdaten-version>:<home-generation>:<signatur>`, 6 Stunden. Nutzerdaten-Version und Home-Generation (`bumpHome`) ändern sich bei jedem Abspielen, Daumen, Bewerten, Merken und Verwerfen; die Signatur bei geänderten Gewichten. Der Eintrag enthält nur Zahlen (die 400 stärksten Dimensionen je Vektor) und Titel-Ids, nie einen Titel. `resetTaste()` verwirft die Einträge eines Profils (für „Meine Empfehlungen zurücksetzen“).
- **Grenzen:** Sterne und Abspielzeiten gehören zum Konto, nicht zum Profil; sie fließen deshalb nur ins Hauptprofil ein. Lesen und Merken sind pro Profil. Der Verlauf hat höchstens 200 Einträge.

**Artikelvektoren** (`vectors.ts`): je Merkmalsgruppe (Genres, Tags, Studios, Personen) der IDF-gewichtete Indikator, L2-normiert und mit dem Gruppengewicht `RECO_W_*` multipliziert; dazu die TF-IDF-Wörter, die Sammlung als eine Dimension und Jahr, Laufzeit und Bewertungen als z-Werte (auf ±3 begrenzt). Der Gesamtvektor ist L2-normiert, das Skalarprodukt also der Kosinus. Der ganze Index liegt 5 Minuten im Prozessspeicher (einige zehn MB bei zehntausenden Titeln); die Nachbarsuche läuft dort. Gleichzeitige Aufrufe teilen sich **ein** Laden (das laufende Promise wird gemerkt); neu geladen wird nach 5 Minuten, bei geänderten Gewichten oder sobald der Index-Job einen Lauf beendet hat (sein Zeitstempel `reco:idx:lastDone` in Redis, so merken es alle Replikate). Dazu gehört ein invertierter Index (Dimension und Vorzeichen → die 400 Titel mit dem stärksten Wert).

**Kandidaten** (`candidates.ts`, jeder trägt seine Quellen)

1. `similar`: `similar()` des Medienservers für den Seed (30), mit Rang.
2. `universe`: Titel derselben Sammlung und Titel, die sich mit dem Seed eine Person aus den ersten 3 Plätzen der Personenliste teilen (Regie, Drehbuch und Urheber stehen im Index vor den Darstellern); bis zu 40.
3. `taste_nn`: die 200 nächsten Nachbarn des positiven Profilvektors im Index (Kosinus), ohne schon Gesehenes. **Begrenzt:** Bewertet werden nur Titel aus dem invertierten Index zu den stärksten Dimensionen des Profils, bis etwa 4000 gesammelt sind, nie die ganze Bibliothek; bei einer kleinen Bibliothek ist das Ergebnis dasselbe wie bei einem vollständigen Durchlauf. Die Quelle `universe` (gleiche Macher) und `prior` lesen ebenfalls aus dem Index statt die Bibliothek zu durchlaufen.
4. `prior`: nur Kaltstart ohne Seed: die bestbewerteten Titel.

Co-Occurrence, Übergänge, Freunde, Trending und Frische-Labels sind seit R3 dabei (Abschnitt unten). Erweiterungspunkt: ein `CandidateSource` (`name`, `social`, `run`) wird mit `registerSource()` eingetragen und kann Zahlen (`cooccurrence`, `transition`, `friends`, `trending`, je 0 bis 1) mitgeben, die die Bewertung je Fläche gewichtet. **Quellen mit `social: true` (und die Namen `cooccurrence`, `transition`, `friends`, `trending`) werden für Kinderprofile nie ausgeführt.** Titel, die die Quellen nur als Id kennen, werden mit der Identität des Betrachters nachgeladen; was sie nicht sehen dürfen, fällt weg.

**Bewertung** (`score.ts`):

```
score = a·Inhaltsnähe + b·Seed-Nähe + c·Co-Occurrence + t·Übergang + d·Freunde + e·Qualität + f·Frische + Trending − Strafen
```

- Inhaltsnähe = cos(positiv) − 0,5·cos(negativ). Seed-Nähe = Kosinus zum Seed, gemischt (70 : 30) mit dem Rang aus `similar()`.
- Qualität: bayessch geglättete Community-Bewertung (Mittel aus Bewertung und dem Bibliotheksmittel mit Vorab-Gewicht 25 Stimmen), auf 0 bis 1 abgebildet (4 bis 9). Jellyfin liefert **keine Stimmenzahl**; angenommen werden deshalb für jeden Titel 25 Stimmen. Das dämpft Ausreißer („10,0“) gleichmäßig, kann aber einen Titel mit 2 Stimmen nicht von einem mit 2000 unterscheiden. Eine Kritikerwertung (`critic_rating`) fließt mit 30 % ein.
- Frische = `0,5^(Tage seit Aufnahme in die Bibliothek / 120)`.
- Trending ist auf allen Flächen höchstens 10 % des Scores (`score.trendingCap`; über `RECO_COEFFS` nur zu senken, nie über 0,1).
- **Strafen:** schon gesehen −0,8 (bei Profilen, die viel wiederschauen, −0,25), `dropped` −1,5, auf der Merkliste −0,4 (sie hat eine eigene Zeile). Fast-Dubletten (Kosinus ab 0,92 zu einem schon gewählten Titel) strafft der MMR-Schritt mit −0,5.
- **Harte Filter:** Daumen-runter, der Seed selbst, alles außer Filme und Serien, und bei Kinderprofilen alles ohne bekannte Freigabe oder über der Altersgrenze (`ratingAge`: FSK/DE-Zahlen, MPAA- und TV-Labels nach einer vorsichtigen eigenen Tabelle: PG = 10, PG-13 = 13, R = 17). Der Medienserver erzwingt dieselbe Grenze ohnehin, weil jede Abfrage mit der Identität des Kindes läuft; der eigene Filter ist ein Gürtel dazu.
- **Flächen** (`surface`), je eine Gewichtsgruppe: `postplay` (Seed-Nähe und später Übergänge vorn), `because` (Seed vorn), `taste` (ohne Seed), `detail_similar` (fast nur Seed), `home_rows`. Die Standardwerte stehen in `weights.ts` (`DEFAULT_RECO_COEFFICIENTS.surface`).

**Umsortierung** (`rank.ts`): MMR mit λ = 0,7 (`λ·Relevanz − (1−λ)·größte Ähnlichkeit zu den schon gewählten`, Relevanz auf 0 bis 1 skaliert), höchstens 2 Titel je Sammlung/Franchise und Zeile, höchstens `ceil(Zeilenlänge·0,5)` (mindestens 2) Titel mit demselben Hauptgenre (das erste Genre im Index). Reicht das nicht für die Zeile, wird die Genre-Grenze gelockert, die Franchise-Grenze nie.

**`recommend(ctx, user, profile, { seed?, surface, limit })`** (`recommend.ts`) verbindet die Schritte. `user` ist die Identität des Betrachters (bei einem Kinderprofil dessen eigene), jeder Aufruf an den Medienserver läuft mit ihr. Antwort: `items` (Titel, Score, Quellen, Teil-Scores), `cold`, `pool` (Scores aller Kandidaten vor der Umsortierung). Ist der Seed eine Folge, gilt ihre Serie.

**Koeffizienten.** Alle Zahlen stehen in `weights.ts` (`DEFAULT_RECO_COEFFICIENTS`) und lassen sich über `RECO_COEFFS` (JSON-Objekt aus Punkt-Namen und Zahlen, Beträge bis 1000) überschreiben, die Halbwertszeit zusätzlich über `RECO_HALF_LIFE_DAYS`. Unbekannte Namen, Nicht-Zahlen und kaputtes JSON werden ignoriert. Gruppen: `signal.*` (Signalgewichte), `profile.*` (Kaltstart-Grenze 5, Abbruch 15 % / 14 Tage, Gewicht des negativen Vektors 0,5, Cache-Dauer), `candidates.*` (200 Nachbarn, 30 `similar`, 40 `universe`), `score.*` (Glättung, Frische, Trending-Grenze), `penalty.*`, `rank.*` (`lambda`, `perFranchise`, `genreShare`, `duplicateCos`), `surface.<fläche>.<teil>` mit den Teilen `affinity`, `seed`, `cooccurrence`, `transition`, `friends`, `quality`, `fresh`, `trending`. Beispiel: `RECO_COEFFS='{"signal.thumbUp2":4,"surface.because.seed":0.6,"rank.lambda":0.8}'`. Die vollständige Liste der Namen liefert `COEFFICIENT_NAMES`. Ein Fixture-Test (`backend/test/reco-engine.test.ts`) hält die Standardreihenfolge fest: Wer einen Standardwert ändert, muss die erwartete Reihenfolge bewusst mitändern.

### v2 auswerten

```
npm run build -w backend            # einmal: der Auswertungslauf nutzt den übersetzten Backend-Code
node scripts/reco-eval.mjs          # popularity, v1, cooccurrence und v2 nebeneinander, dazu v2 gegen jede Basis und das Tor
node scripts/reco-eval.mjs --gate   # Exit-Code 1, wenn das Tor nicht bestanden ist
DATABASE_URL=… node scripts/reco-eval.mjs --db --items items.json --similar similar.json
```

`RECO_EVAL_DIST=<Verzeichnis>` zeigt auf einen anderen Build. Ohne Build wird v2 übersprungen (Hinweis auf stderr); `--engines v2` bricht dann mit einer Meldung ab. v2 läuft offline mit demselben Code wie im Betrieb (Profilmathematik, Vektoren, Bewertung, MMR; `backend/src/reco/offline.ts`), nur aus dem Datensatz gespeist: Der Index wird aus den Datensatz-Titeln gebaut, `similar()` kommt aus `--similar` (ohne Angabe nehmen die nächsten Nachbarn des Seeds seinen Platz), Signale sind „gesehen“ (+1,0), „Daumen hoch“ (+1,5) und „Daumen runter“ (−4,0) mit Zeitabfall. Zusätzliche Titelmerkmale im Datensatz (alle optional): `tags`, `studios`, `people` (Listen), `runtime` (Minuten), `rating` (0 bis 10), `collection`, `added` (ms). `--items` sollte sie enthalten, sonst kennt v2 nur Genre und Jahr.

Die Ausgabe ergänzt die Tabelle um den Vergleich von v2 mit jeder Basis (Prozentpunkte, `*` = v2 besser) und das Tor aus der Spezifikation: v2 braucht beim NDCG@10 mindestens `--gate-margin` (Standard 0,05 = 5 %) Vorsprung vor **jeder** Basis. Die mitgelieferten Testdaten sind synthetisch (sechs Genre-Cluster) und begünstigen inhaltsbasierte Verfahren; sie prüfen die Mechanik, nicht die Qualität. Aussagekräftig ist der Lauf erst mit den Daten der eigenen Instanz. Das Tor ist nur ein Teil der Freigabe: Dazu kommt die Wiedergabequote nach 2 Wochen im Shadow-/Teilbetrieb (R4).

## Empfehlungs-Engine v2: Quellen, Kontext, Erklärungen (R3)

Gilt für alle Flächen von `recommend()`; der Standard bleibt `RECO_ENGINE=v1`. Neue Dateien in `backend/src/reco/`: `aggregates.ts` (Co-Occurrence und Übergänge), `sources.ts` (Quellen), `context.ts` (Kontext-Faktoren), `explain.ts` (Begründungen). Es gibt keine neuen Umgebungsvariablen; alle Zahlen sind Koeffizienten (`social.*`, `context.*`, `surface.*`) und über `RECO_COEFFS` änderbar.

### Co-Occurrence und Übergänge (`aggregates.ts`)

- **Co-Occurrence:** „Konten, die X gesehen haben, haben auch Y gesehen“. Wert = n(X und Y) / √(n(X)·n(Y)), gezählt über verschiedene Konten (Kosinus, 0 bis 1).
- **Übergang (Transition):** „Konten, die X zu Ende gesehen haben, haben direkt danach Y begonnen (innerhalb von 7 Tagen)“. Y ist der erste Titel, den das Konto nach der letzten Wiedergabe von X angefangen hat; Titel, die schon während X liefen, zählen nicht. Wert = n(X→Y) / (n(X fertig) + 1).
- **Nur mit Einwilligung, nur Aggregate:** Es zählen ausschließlich Konten mit `shareHistory` (dieselbe Einstellung wie bei „Diese Woche bei uns“; aus = ausgeschlossen, Voreinstellung aus). Ein Paar zählt erst ab **mindestens 2 verschiedenen Konten** (`social.minSupport`; die Untergrenze 2 lässt sich auch über `RECO_COEFFS` nicht unterschreiten). Die Tabellen enthalten nur Zähler je Titelpaar (stärkste 30 Partner je Titel), keine Konto-Id, keinen Tag, keine Uhrzeit; sie gelten 15 Minuten als frisch (`reco:pairs:…`). Schaltet jemand `shareHistory` aus, ist das Konto spätestens beim nächsten Neuaufbau draußen. **Ohne das eigene Konto:** Beim Lesen wird abgezogen, was das Konto des Betrachters selbst beigetragen hat; ein Paar sieht man also nur, wenn mindestens 2 **andere** Konten es teilen. Wer eines von nur zwei Konten hinter einem Paar ist, erfährt so nicht den nächsten Titel der anderen Person.
- **Ein Erbauer:** Die Tabellen baut immer nur einer: im Prozess teilen sich gleichzeitige Aufrufe den laufenden Aufbau, über Replikate hinweg sperrt ein Redis-Lock (`reco:pairlock:…`, `setnx`). Eine abgelaufene Tabelle bleibt bis zum Vierfachen der Frist liegen, wird sofort beantwortet und im Hintergrund von einem Erbauer ersetzt; nur wenn es gar keine gibt, wartet die Anfrage auf den Aufbau (hält ein anderes Replikat das Lock, gibt es vorerst leere Tabellen). Die Tabellen hängen nicht davon ab, wessen Anfrage den Aufbau auslöste: es wird kein Token eines Betrachters benutzt.
- **Grundlage:** `play_seconds` der letzten 365 Tage. „Gesehen“ = mindestens 300 Sekunden je Titel (Folgen werden zur Serie gerechnet: über die Folgenzeilen des Hygiene-Scans, sonst über die bibliotheksweite Admin-Abfrage `libraryRoots()` des Medienservers; nie mit der Identität eines Betrachters, und „nicht in der Bibliothek“ merkt sich nur diese bibliotheksweite Abfrage). Grenzen: `play_seconds` kennt das Konto, nicht das Profil, und nur den Tag; eine Wiedergabe unter einem Kinderprofil zählt daher für das Konto (wie bei „Diese Woche bei uns“). Ein „fertig gesehen“-Merkmal gibt es dort nicht; als **Näherung** gilt ein Film ab 70 % seiner Laufzeit und eine Serie ab 3 Folgen Sehzeit (`social.finishRatio`, `social.finishEpisodes`).
- **Wer bekommt sie:** Quellen `cooccurrence` und `transition` laufen nicht bei Kinderprofilen und nur, wenn die Fläche dem Signal ein Gewicht gibt. Die Co-Occurrence nimmt den Seed; Flächen ohne Seed (`taste`, `home_rows`) nehmen die „Anker“ des Profils (seine 5 stärksten Titel). Übergänge brauchen einen Seed (den eben fertig gesehenen Titel).
- **`transitionsFor(ctx, itemId, { user, profile }, { limit? })`** (`reco/aggregates.ts`) ist die Schnittstelle für den Post-Play-Bildschirm (wird in R4 angeschlossen): „Was Leute danach sehen“, stärkste zuerst, je mit Unterstützung (Anzahl Konten) und Anteil, mit der Identität des Betrachters aufgelöst, ohne Daumen-runter und ohne schon Gesehenes. Eine Folge zählt als ihre Serie; ein unsichtbarer Titel ergibt eine leere Liste; **ein Kinderprofil bekommt immer eine leere Liste**, ohne dass die Daten gelesen werden.

### Freunde, Trending, Frische

- **Freunde** (`friends`): die vorhandenen Abfragen, jetzt in `backend/src/discoverData.ts` (`friendsRatedRows`, `recommendationRows`; die Routen `friends-rated` und `recommendations` benutzen sie unverändert). Freundes-Bewertungen ab 4 Sternen nur von Konten mit `shareRatings` (Voreinstellung an), Empfehlungen, die Freunde diesem Konto geschickt haben. Signal: 4 Sterne 0,5, 5 Sterne 1,0 (plus 0,1 je weiterem Freund, höchstens 0,2), eine direkte Empfehlung 1,0. Namen erscheinen nur in der Begründung und nur so weit diese Einwilligungen reichen; die Notiz einer Empfehlung nie. Nie für Kinderprofile.
- **Trending** (`trending`): die Aggregate von „Diese Woche bei uns“ (jetzt `trendingItems()` in `discoverData.ts`, die Route ruft sie auf; mindestens 2 Zuschauer, `shareHistory`). Signal = ln(1+Zuschauer) / ln(1+Maximum). **Der Anteil von Trending am Score ist auf jeder Fläche höchstens 10 %** (`score.trendingCap`): `trending ≤ 0,1/0,9 · (Rest des Scores)`, also höchstens 10 % von Rest + Trending vor den Strafen; `detail_similar` gibt ihm gar kein Gewicht. Ein Test erzwingt das auf allen fünf Flächen mit absichtlich riesigem Gewicht. Nie für Kinderprofile.
- **Frische** (`fresh`): die zuletzt hinzugefügten Titel (`DateLastContentAdded`) mit den Labels aus `fresh.ts` (`badgesFor`): neue Serie und neuer Film, bei einer Serie, die das Profil schon sieht, nur „neue Staffel“. Ein gelabelter Titel zählt mit mindestens 0,8 als frisch (`score.freshLabelBoost`), und eine neue Staffel einer gesehenen Serie bekommt die Strafe „schon gesehen“ nicht (sie ist neuer Inhalt). Das ist keine Sozialquelle und läuft auch bei Kinderprofilen, mit deren Token und Altersgrenze.

### Kontext-Faktoren (`context.ts`)

Weiche Multiplikatoren auf den Score, **nie Filter**: Jeder Faktor liegt um 1, das Produkt wird auf [0,75; 1,2] begrenzt (`context.min`, `context.max`), und ohne Daten ist ein Faktor genau 1. 0 schaltet einen Faktor ab (`context.timeOfDay`, `.device`, `.language`, `.runtime`, `.status`).

| Faktor | Wirkung | Daten |
|---|---|---|
| Tageszeit (Eimer: Morgen 5–11, Nachmittag 12–16, Abend 17–22, Nacht 23–4, in der Zeitzone der Instanz `TZ`) | bis ±15 %: Genres, die das Profil in diesem Eimer öfter sieht als sonst, steigen (erst ab 5 Wiedergaben im Eimer) | eigene Wiedergaben des Profils, nur Zahlen im Taste-Cache |
| Gerät | bis ±10 %: kurze Titel passen zu Handys (≤ 45 min +1, ≥ 150 min −1), lange zu Fernsehern (≥ 100 min +0,5, ≤ 30 min −0,5) | Gerät des Aufrufers (`device`), sonst die Geräteverteilung der Instanz zu dieser Tageszeit aus `playback_timings` (anonym, 14 Tage, mindestens 30 Starts je Eimer, 1 h gecacht) |
| Sprache | bis ±10 %: Anteil der Originalsprache des Titels an dem, was das Profil mag; ohne Verlauf ein halber Bonus für die UI-Sprache | `original_language` des Index (bei Jellyfin leer, dann 1), `profile_prefs.language` |
| Laufzeit gegen Zeitbudget | bis −15 %: über dem Budget der Stunde (Tag 240 min, 17–20 Uhr 180, 21–22 Uhr 120, 23–4 Uhr 90); Serien zählen mit der Folgenlänge | `runtime_min` |
| Serienstatus gegen Abbruchverhalten | bis ±10 %: Profile, die mindestens 30 % ihrer begonnenen Serien abgebrochen haben, bekommen laufende Serien gedämpft und beendete leicht angehoben (mindestens 3 begonnene Serien nötig) | `dropped`, frühes Abbrechen |

### Gewichte je Fläche

`postplay`, `because`, `taste`, `detail_similar`, `home_rows` haben je einen Satz (`DEFAULT_RECO_COEFFICIENTS.surface`). Seit R3 neu: **Post-Play gewichtet Übergänge (0,6) und Seed-Nähe (0,5) am höchsten**, `because` und `detail_similar` ohne Übergänge, `taste` ohne Seed; Freunde gehen mit 0,05 in `postplay` und `because` ein (dort gibt es eigene Zeilen), mit 0,15 in `taste` und `home_rows`, nicht in `detail_similar`. Die Werte sind begründete Startwerte, keine aus Messungen abgeleiteten; die mitgelieferten Testdaten können sie nicht entscheiden (siehe Ablation). Abstimmen soll R5 mit den Daten der eigenen Instanz.

### Begründungen (`explain.ts`)

Jeder Titel trägt `reason = { seed, traits }`:

- **`seed`** (`{ id, name }` oder `null`): der Titel, der am meisten beigetragen hat. Mit Seed (Post-Play, „Weil du …“, Detailseite) ist es der Seed. Ohne Seed oder bei einer Crowd-Quelle der Anker, der die Co-Occurrence geliefert hat, sonst der stärkste Anker des Profils mit dem größten Beitrag (Gewicht · Kosinus zum Titel). Ein Kaltstart-Profil hat keinen.
- **`traits`**: bis zu 2 gemeinsame Eigenschaften, als `art` oder `art:wert`, in dieser Reihenfolge: `friends[:Anna, Ben]` (Freunde haben bewertet oder empfohlen, Namen nur mit Einwilligung), `next` („Leute sehen danach“, Übergang), `together` („wer das sah, sah auch“, Co-Occurrence; nicht in der Spezifikationsliste, weil dort kein Eintrag für Co-Occurrence vorgesehen war), `universe` (gleiche Sammlung), `director[:Name]`, `actor[:Name]`, `studio:Name`, `genre:name` (das seltenste gemeinsame Genre). Je Art höchstens eine. Namen von Personen stammen aus den Besetzungsdaten des Seeds (ein Aufruf `credits()` je Seed, höchstens 3 je Aufruf, mit dem Token des Betrachters); ohne sie steht nur die Art.
- Weder Titel noch Namen gelangen in Metriken oder Logs.

### Empfehlungs-Engine v2: Zeilen-Ranker und Exploration (R3b)

### Zeilen-Ranker (`reco/rows.ts`)

Regelbasierte zweite Ebene (Spezifikation 4.5): `rankRows(zeilen, { c, stats, seen, kids, now })` ordnet die verfügbaren Zeilen der Startseite oder des Post-Play-Bildschirms und bereinigt ihren Inhalt. Angeschlossen wird er in R4; bis dahin ist er ein getesteter Baustein.

1. **„Weiter schauen“ (`continue`, bei Post-Play die Fortsetzung) steht immer ganz oben.**
2. **Ein fester Platz** (`rows.fixedSlot`, Standard Position 3 der Liste) für „Bald nicht mehr verfügbar“ (`leaving`), sonst „Neu“ (`new`). Sind beide da, bekommt `leaving` den Platz und `new` konkurriert wie jede andere Zeile.
3. **Die übrigen Zeilen nach der bisherigen Klick-/Abspielrate des Profils je Zeilenart:** `(Klicks + 2·Abspielungen − Verwerfen + 0,1·20) / (Einblendungen + 20)`, also zum Vorwert 0,1 hin geglättet; eine Zeilenart ohne Verlauf behält ihre Standardreihenfolge (stabile Sortierung).
4. **Mindestgröße** je Zeilenart: `rows.minSize` = 4 Titel, aber `continue` und `universe` 1, `transition` 2 (`ROW_MIN_SIZE`); kleinere Zeilen entfallen. So zeigt der Bildschirm nach dem Ende unter v2 dieselben Zeilen wie unter v1 (eine Trilogie lässt nur 1 oder 2 Teile übrig).
5. **Keine schon gesehene Serie** in irgendeiner Zeile außer `continue` (Anti-Muster aus 2.3 Punkt 11); einzige Ausnahme: eine neue Staffel einer gesehenen Serie im „Neu“-Platz.
6. **Keine Zeile nur aus Titeln der laufenden Staffel:** höchstens 1 von 3 Titeln (`rows.currentShare`) einer Zeile darf eine Serie sein, die gerade läuft (Label `newEpisode|newSeason|newSeries|finale` aus `fresh.ts` oder in den letzten 120 Tagen hinzugekommen/erschienen); der Rest muss Altbestand sein, sonst entfällt die Zeile. „Neu“ ist ausgenommen.
7. Ein Titel steht nur in der ersten Zeile, in der er vorkommt.
8. **Kinderprofile** bekommen nie `friends`, `popular` oder `transition`.

**Statistik je Profil** (`loadRowStats`, `recordRowStats`): ein kv-Eintrag `reco:rows:<profil>` mit vier Zählern (gezeigt, geklickt, abgespielt, verworfen) je Zeilenart, also höchstens 12 × 4 Zahlen, nur Zähler, keine Titel. Sobald eine Zeilenart über `rows.statsCap` (500) Einblendungen kommt, werden alle Zähler halbiert (neueres Verhalten zählt mehr); Lebensdauer 180 Tage. Gefüttert von `POST /api/reco/events` für das aktive Profil; `plays` zählt der Server erst ab R4. `resetRowStats()` gehört zu „Meine Empfehlungen zurücksetzen“ (R4).

### Exploration (`RECO_EXPLORE`, Standard 0 = aus)

- `RECO_EXPLORE=0.1`: etwa jeder zehnte Platz einer Zeile wird statt des gerankten Titels mit einem Titel **mittleren Scores** gefüllt (`explore.ts`): gezogen wird gleichverteilt aus den Kandidaten auf den Rängen 25 % bis 60 % des nach Score geordneten Pools (`explore.from/to`), die nicht schon in der Zeile stehen, einen positiven Score haben und die Franchise-Grenze einhalten. Die besten 3 Plätze (`explore.protectTop`) bleiben unberührt. Bereich 0 bis 0,5.
- **Aus heißt aus:** bei `0` wird keine Zufallszahl gezogen, nichts gezählt, die Liste ist bei jedem Aufruf gleich. Shadow-Vergleiche erkunden nie. Kinderprofile erkunden nur innerhalb der Altersgrenze (der Pool ist schon gefiltert).
- **Propensity-Protokoll, nur Zähler nach Zeilenart:** `friendflix_reco_explore_slots_total{row,arm}` (belegte Plätze) und `friendflix_reco_explore_propensity_total{row,arm}` (Summe der Propensities; Mittel = Summe / Plätze). `row` stammt aus `ROW_KINDS`, `arm` ist `exploit|explore`; Propensity eines gerankten Platzes = 1 − Rate, eines erkundeten = Rate / Größe des mittleren Bereichs. Kein Titel, keine Id, kein Nutzer. In `recommend()` tragen erkundete Einträge `explored: true` und `propensity`.

### Replay mit inverser Propensity-Gewichtung

```
node scripts/reco-eval.mjs --ipw [--explore 0.1] [--rounds 200] [--seed 1]
```

Die Logging-Politik ist v2 mit Exploration (gleicher Code wie live, `reco/explore.ts`, mit festem Zufallsgenerator); je Fall werden `--rounds` Listen „geloggt“, jeder Platz mit seiner Propensity. Eine Ziel-Politik wird allein aus dem Log bewertet: `Wert = Mittel über Fälle und Runden von Σ_Plätze Rabatt(j) · [geloggt_j = Ziel_j = gesuchter Titel] / Propensity_j` (Rabatt = 1/log2(j+2), also NDCG@10) und neben ihren wahren Wert gestellt. „support“ ist der Anteil der Plätze, an denen das Log den Zieltitel überhaupt gezeigt hat; nur dafür ist die Schätzung erwartungstreu („true, supported“ ist der wahre Wert nur über diese Plätze). Titel, die das Log nie zeigt, lassen sich nicht bewerten: für Ziele, die von v2 abweichen, ist die Schätzung eine Untergrenze. Auf den Testdaten:

```
inverse-propensity-weighted replay of the v2 logging policy with exploration 0.1 (profiles: 36, rounds: 200, seed: 1, k=10)

target policy                  true NDCG@10  true, supported     IPW estimate            error          support          matches           eff. n
v2                                    0.579            0.579            0.579            0.000           100.0%             4959             4955
v2 without cooccurrence               0.539            0.494            0.494            0.000            50.8%             4180           4177.9
v2 without affinity                   0.383            0.222            0.222            0.000            18.3%             1600             1600
popularity                            0.028            0.000            0.000            0.000            15.0%                0                0
cooccurrence                          0.489            0.278            0.278            0.000            23.1%             2000             2000

support = share of the target slots whose title the logging policy showed there at least once. "true, supported" = the true value counting only supported slots;
the IPW estimate is unbiased for that (error = IPW minus it). Titles the log never showed cannot be valued, so for a target that differs from v2 the estimate is a lower bound of the true value.
A target is valued from the explored slots that happen to match: noisy (see eff. n).
```

Lesehilfe: v2 selbst wird richtig geschätzt; Ziele fern von v2 (Popularität, Co-Occurrence) liegen fast ganz außerhalb des Supports, ihre Schätzung ist entsprechend klein. Das ist die bekannte Grenze: Exploration macht nur Rankings bewertbar, die dem geloggten ähneln. Mit echten Zählern läuft das nicht (sie sind absichtlich nur Aggregate je Zeilenart); der Lauf zeigt die Mechanik und dient dazu, in R5 kleine Änderungen offline zu beurteilen.

## Empfehlungs-Engine v2: Rollout (R4)

Alles hinter `RECO_ENGINE=v2`. Standard bleibt `v1`: Ohne Umschalten ändert sich weder eine Antwort noch ein Zähler, und es gibt keine Bildunterschriften. `shadow` rechnet weiter nur nebenher (R2) und antwortet v1.

**Was über `recommend()` läuft** (Code: `reco/engine.ts`, `routes/discover.ts`, `routes/home.ts`, `postplay.ts`)

| Stelle | v2 |
|---|---|
| Startseite, „Weil du … gesehen hast“ (`GET /api/library/because`, Teil von `GET /api/home`) | `recommend({ surface: 'because', seed })` |
| Weitere „Weil du …“-Zeilen (`GET /api/library/because-more`) | je Seed `recommend({ surface: 'because' })`; eine Zeile, deren v2-Aufruf scheitert, kommt von Jellyfin (`engine: 'v1'` an dieser Zeile) |
| Bildschirm nach dem Ende, Zeile „Weil du …“ | `recommend({ surface: 'postplay', seed })` |
| Bildschirm nach dem Ende, Zeile „Passt zu deinem Geschmack“ | `recommend({ surface: 'taste' })` ohne Seed |
| Bildschirm nach dem Ende, neue Zeile „Was andere nach … schauen“ (`kind: 'transition'`) | `transitionsFor()` (R3): mindestens 2 Konten mit `shareHistory` je Paar; nie für Kinderprofile |

**Zeilenreihenfolge** (`rankRows`, R3b). Startseite: `parts.order` listet die Empfehlungszeilen (`friends`, `because`, `more:<n>`) in der Reihenfolge des Rankers; eine nicht genannte Zeile ist weg (zu klein, nur schon gesehene Serien, zu viele aktuelle Titel). Die Antwort enthält die bereinigten Titel. Fehlt `order` (v1, oder der Ranker ist ausgefallen), gilt das feste Layout wie bisher. „Weiterschauen“, „Nächste Folge“ und „Bald nicht mehr verfügbar“ bleiben, wo sie sind. Bildschirm nach dem Ende: die Fortsetzung bleibt oben, die übrigen Zeilen ordnet der Ranker nach der Klick- und Abspielrate des Profils je Zeilenart (`PostplayRow.recoRow`: `transition`, `universe`, `postplay` für „Weil du …“, `friends`, `top_picks` für „Geschmack“). Eine Zeile mit weniger als 4 Titeln fällt weg (`rows.minSize`); „Gleiches Universum“ braucht 1 Titel, die Übergangszeile 2 gestützte Folgetitel. Zusätzliche „Weil du …“-Zeilen (`more:<n>`) unter 4 Titeln zeigt die Startseite auch unter v2 nicht. Die v2-Zeile „Weil du …“ wird wie der Jellyfin-Teil 10 Minuten gecacht (Schlüssel mit Nutzerdaten-Version und Home-Generation) und von gleichzeitigen Aufrufen geteilt.

**Begründung (`reason`).** Jeder Titel einer v2-Zeile trägt `reason: { seed, traits[≤2] }` (`reco/explain.ts`). Das Web macht daraus eine Zeile unter der Überschrift („Weil du „Dune“ gesehen hast · gleiche Regie“), in allen 7 Sprachen (`lib/reason.ts`, Bereich `reco`). Sie zeigt den ersten Titel der Zeile; ein Tipp darauf öffnet „Warum sehe ich das?“ mit der Begründung der ersten fünf Titel (eingeblendet, kein Pop-up). Unbekannte Merkmale einer neueren Version bleiben weg. Freundesnamen stehen nur drin, soweit deren Freigaben es erlauben (R3).

**Rückfall auf v1.** Wirft v2 (Index nicht lesbar, Datenbank, Medienserver), antwortet v1 und `friendflix_reco_fallback_total{surface}` steigt um 1 (`surface` ∈ `because`, `because_more`, `postplay`, `taste`, `transition`, `home`; keine Meldung, kein Titel). Nur eine Ausnahme zählt; eine leere v2-Antwort bleibt leer. Zeilen sagen, wer sie gebaut hat (`engine`), die Zähler folgen dem.

**Zähler** (`POST /api/reco/events`, Zählwerte je `row` und `engine`): `friendflix_reco_impressions_total`, `_clicks_total`, `_plays_total`, `_dismiss_total`. Ein *Abspielen* zählt, wenn die Wiedergabe eines Titels beginnt, den man aus einer Empfehlungszeile geöffnet hat (der Browser merkt sich Zeile und Engine in `sessionStorage`, 30 Minuten; ein Link direkt auf `/watch/…` zählt sofort). *Ablehnen* kommt aus „Kein Interesse“ am Bildschirm nach dem Ende. Die Zähler enthalten keine Titel, Ids oder Profile; dieselben Zahlen füttern je Profil die Zeilenstatistik des Rankers.

**Profil-Einstellungen** (`routes/prefs.ts`, Seite „Einstellungen“, auch für Kinderprofile)

- **Meine Empfehlungen zurücksetzen:** `POST /api/prefs/reco/reset` löscht den zwischengespeicherten Geschmacksvektor (`reco:taste:<profil>:…`) und die Zeilenstatistik (`reco:rows:<profil>`) dieses Profils und verwirft dessen Startseiten- und Post-Play-Zwischenspeicher. Daumen, Bewertungen, Verlauf und Merkliste bleiben; v2 baut den Geschmack beim nächsten Aufruf daraus neu auf.
- **Warum sehe ich das?:** der Tipp auf die Zeile unter einer Empfehlungszeile (siehe oben). Die Einstellungsseite erklärt es in einem Satz.

**Admin-Karte** (Übersicht, `GET /api/admin/reco`): je Engine angezeigt, geklickt, abgespielt, abgelehnt, dazu **Klickrate = Klicks ÷ angezeigte Zeilen** und **Abspielrate = Abspielungen ÷ angezeigte Zeilen**, außerdem die Rückfälle auf v1. Quelle sind die Zähler dieses Prozesses: Sie beginnen bei jedem Neustart bei 0, die Geschichte liegt in Prometheus. Ohne Anzeigen steht „–“ statt einer Rate.

**Kinderprofile** bleiben, wie sie waren: Altersgrenze immer, nie Freunde, Co-Watch, Übergänge oder Trending, alle Titel mit dem Token des Kindes. Die Übergangszeile wird für sie weder gebaut noch werden die Übergangsdaten gelesen.

### Shadow gegen v1 vergleichen und wann umschalten

Das Tor der Spezifikation (§4.7): v2 wird Standard, wenn der NDCG@10 offline **jede** Basis um den Abstand schlägt **und** die Abspielrate online nach zwei Wochen nicht schlechter ist. Die Umstellung macht die Betreiberin oder der Betreiber selbst; ausgeliefert wird `v1`.

1. **Offline:** `node scripts/reco-eval.mjs --gate` (siehe „v2 auswerten“); mit `--db` auf den eigenen Daten. Besteht das Tor nicht, nicht umschalten.
2. **Shadow, mindestens eine Woche:** `RECO_ENGINE=shadow`. Viewer sehen v1. Prüfen: `friendflix_reco_shadow_runs_total{result="error"}` bleibt ≈ 0; `friendflix_reco_shadow_overlap` (Histogramm): liegt der Mittelwert bei 1, ist v2 nur eine Kopie von v1, bei sehr niedrigen Werten ist v2 ein ganz anderer Geschmack, dann Stichproben ansehen; `friendflix_reco_shadow_score_delta` positiv heißt, v2 hält seine Liste für besser, sagt aber nichts über die Zuschauer. Mittelwerte: `sum(rate(friendflix_reco_shadow_overlap_sum[7d])) / sum(rate(friendflix_reco_shadow_overlap_count[7d]))`.
3. **Grundlinie festhalten:** die Abspielrate von v1 aus den Wochen davor (Admin-Karte seit dem letzten Neustart, besser Prometheus): `sum(increase(friendflix_reco_plays_total{engine="v1"}[14d])) / sum(increase(friendflix_reco_impressions_total{engine="v1"}[14d]))`. Ein Profil ohne Verlauf (kalt) bekommt bei v2 vor allem Beliebtes; wenige Profile mit Verlauf: lieber länger messen.
4. **Umschalten:** `RECO_ENGINE=v2`, Backend neu starten. In den zwei Wochen danach die v2-Abspielrate (gleiche Abfrage mit `engine="v2"`) mit der Grundlinie vergleichen und `friendflix_reco_fallback_total` im Blick halten (Rückfälle sollten nahe 0 bleiben). Ist die Abspielrate schlechter als die Grundlinie, `RECO_ENGINE=v1` setzen; das ist jederzeit ohne Datenverlust möglich. „Meine Empfehlungen zurücksetzen“ ändert nichts an dieser Messung.
5. **Aufgepasst:** Klickrate und Abspielrate hängen auch von der Bibliothek und der Jahreszeit ab; ein Vergleich von v1 und v2 zu verschiedenen Zeiten ist ein Hinweis, kein Beweis. Die Zähler sind pro Zeilenart getrennt (`row`), vergleiche gleiche Zeilen.

## Kinderprofile

Nie Co-Occurrence, Übergänge, Freunde oder Trending (die Quellen sind `social` und werden in `gatherCandidates` übersprungen; jede prüft es zusätzlich selbst), immer die Altersgrenze (eigener Filter plus Token des Kindes bei jedem Aufruf), keine Begründung mit Freunden. Tests: `backend/test/reco-sources.test.ts` (Quellen, Altersgrenze, nur Kind-Token, keine Abfrage von Wiedergaben, Bewertungen oder Empfehlungen anderer Konten).

### Ablation: welche Bestandteile den NDCG@10 bewegen

```
node scripts/reco-eval.mjs --ablation
```

v2 wird mit jedem Bestandteil einzeln abgeschaltet und gegen v2 „wie es ist“ gehalten. Die Tabelle: NDCG@10 und HitRate@10 der Fläche „Startseite“, Übergangs-Genauigkeit der Fläche „was kommt danach“, Diversität; `d …` = ohne Bestandteil minus mit. Urteil: „helps“, wenn NDCG@10 oder Übergangs-Genauigkeit ohne den Bestandteil um mehr als ein Profil (1/Profile) fallen, „hurts“ wenn sie steigen, „trade-off“, wenn sie steigen, die Listen aber an Diversität verlieren, sonst „no effect“. Nicht auswertbar mit einem Datensatz (er hat weder Uhrzeit noch Gerät, Freunde oder Bibliotheksdaten): Kontext-Faktoren, Freunde-Signal, Frische-Labels.

Lauf auf den mitgelieferten Testdaten (`node scripts/reco-eval.mjs --ablation`):

```
ablation of engine v2: each component switched off in turn (profiles evaluated: 36, k=10)

left out            NDCG@10     d NDCG HitRate@10      d Hit Transition    d Trans  Diversity      d Div  verdict
(v2 as is)            0.579                 69.4%                 66.7%                 0.934           
affinity              0.383     -0.196      52.8%     -0.167      63.9%     -0.028      0.944     +0.010  helps
seed                  0.579      0.000      69.4%      0.000      72.2%     +0.056      0.934      0.000  hurts
cooccurrence          0.539     -0.040      66.7%     -0.028      66.7%      0.000      0.936     +0.003  helps
transition            0.579      0.000      69.4%      0.000      66.7%      0.000      0.934      0.000  no effect
quality               0.578     -0.001      69.4%      0.000      66.7%      0.000      0.934      0.000  no effect
fresh                 0.579      0.000      69.4%      0.000      66.7%      0.000      0.934      0.000  no effect
trending              0.576     -0.003      72.2%     +0.028      58.3%     -0.083      0.931     -0.002  helps
mmr                   0.696     +0.117      91.7%     +0.222      66.7%      0.000      0.602     -0.332  trade-off

verdict: "helps" = NDCG@10 or transition accuracy falls by more than 0.0278 (one profile's worth) without the component, "hurts" = it rises,
"trade-off" = it rises but the lists lose diversity (the component buys diversity), "mixed" = one up, one down, else "no effect"
not evaluable on a dataset: context features (time of day, device, language, runtime budget, series status); friends signal; fresh labels of the media server
```

Lesehilfe und Grenzen:

- Die mitgelieferten Testdaten sind klein (36 ausgewertete Profile, 1 Profil ≈ 0,028 NDCG) und inhaltsgetrieben; Unterschiede unter einem Profil sind Rauschen. Das Bild zeigt die Mechanik, nicht die Qualität auf einer echten Instanz.
- Das Taste-Profil (`affinity`) trägt fast alles (NDCG@10 −0,20 ohne). Co-Occurrence hilft (−0,04 ohne). Trending bewegt den NDCG@10 nicht (−0,003), die Übergangs-Genauigkeit um 3 Profile (Rauschen oder echt, kann dieser Datensatz nicht sagen). Qualität und Frische bewegen auf diesen Daten nichts (keine Bewertungen, keine Aufnahmedaten).
- Einzeln abgeschaltet verdeckt die Tabelle Wechselwirkungen: schaltet man Co-Occurrence **und** Trending gemeinsam ab, steigt der NDCG@10 der Startseite auf den R2-Wert 0,648 (die beiden Crowd-Signale bringen auf diesen inhaltsgetriebenen Daten Titel in die Liste, die das Profil nicht vorhersagt). Das Tor (v2 gegen die beste Basis, Co-Occurrence 0,489) besteht weiter: 0,579 gegen 0,489.
- `transition` zeigt hier keine Wirkung, weil auf den Testdaten nur 2 der 36 gesuchten Titel ein gestützter Nachfolger des Seeds sind. Dass Übergänge die Folge auf sequentiellen Daten vorhersagen, prüft ein eigener Test (`scripts/reco-eval.test.mjs`: Ketten a1→a2→a3→a4: Übergangs-Genauigkeit 100 %, ohne Übergänge und Co-Occurrence 0 %).
- `seed` verschlechtert die Übergangs-Genauigkeit der Testdaten um 2 Profile; die Spezifikation verlangt trotzdem, dass Post-Play die Seed-Nähe hoch gewichtet. Entscheiden soll der Lauf mit `--db` auf echten Daten (R5).
- `mmr` kostet Genauigkeit und kauft Diversität (0,60 → 0,93): so gedacht.

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
