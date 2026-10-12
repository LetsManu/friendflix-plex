# Suche & Entdecken – API

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

## Web

- **`/search`:** Die Abschnitte heißen Personen, Genres, Filme & Serien und Folgen.
  - Der Zustand steckt in `?q=`.
  - Die letzten 8 Suchen werden lokal im Browser gespeichert und lassen sich löschen.
  - `/` oder Strg/⌘+K springt von überall in die Suche.
- **`/person/<id>`:** Filmografie mit Filter Alle/Filme/Serien. „In Filmen stöbern“ öffnet `/browse/movies?person=<id>`.
- **`/browse/movies|series`:** Filter für Genre, Jahrzehnt, Bewertung, Sortierung und Status.
  - Aktive Filter erscheinen als Chips mit ×.
  - Alle Filter stehen in der URL und lassen sich teilen.
