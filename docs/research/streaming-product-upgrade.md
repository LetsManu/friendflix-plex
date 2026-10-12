# Streaming product research – discovery upgrade

Stand: Oktober 2026. Ziel: Muster etablierter Streaming-, Tracking- und Social-Produkte finden, die für FriendFlix (selbst gehostet, Jellyfin + Seerr, kleiner Freundeskreis) echten Nutzen bringen – ohne Marken, Texte, Bilder oder proprietäre Oberflächen zu übernehmen.

Methodik: öffentliche Hilfeseiten, Produkt-Blogs und Fachartikel (Quellen unten), plus ein Audit der eigenen Codebasis (Frontend, Backend, Qualität/CI). Was nicht direkt in einer Quelle bestätigt werden konnte, ist als „unbestätigt“ markiert.

## Beobachtete Muster

| Muster | Wo gesehen | Relevanz für FriendFlix |
|---|---|---|
| Suche nach Titel, Genre **und Person**, Ergebnisse nach Art eingrenzbar | Netflix (Hilfeartikel zur Suche) | Hoch – FriendFlix suchte nur nach Titeln |
| Browse mit Filter-Steuerung (z. B. Sprache/Dub), auf Mobil per Filter-Icon + „Filter anwenden“ | Crunchyroll (Hilfe: Dub-Filter) | Hoch für Filter; Sprachfilter siehe „nicht umgesetzt“ |
| Standard-Watchlist plus benannte eigene Listen, Status „in Liste“ auf der Titelseite | Crunchyroll (Watchlist + Crunchylists), Trakt | Bereits vorhanden (Meine Liste + geteilte Listen) |
| Freunde-Aktivität und „Freunde haben das gesehen/bewertet“ auf der Titelseite, Sichtbarkeit pro Kategorie (privat/Freunde) | Plex „Discover Together“ | Teilweise vorhanden (Bewertungen, Empfehlungen) – Privatsphäre-Opt-out muss überall greifen |
| Watchlists zweier Personen vergleichen (Schnittmenge) | Letterboxd | Vorhanden als „Gemeinsam schauen“ (/match) |
| Serie „abbrechen“: verschwindet aus Weiterschauen/Kalender, Verlauf bleibt | Trakt „Drop Show“ | Teilweise vorhanden („Aus Weiterschauen entfernen“) |
| Reaktionen pro Folge erst nach dem Ansehen sichtbar (Spoiler-Gate) | TV Time (ältere Quellen) | Mittel – passt zu vorhandenem Spoiler-Schutz |
| Tägliche Top-10-Reihe mit Rang-Badge | Netflix | Vorhanden („Top bei uns“-ähnliche Reihen) |
| Mood-/Themen-Hubs, kuratierte Sammlungen | Netflix (unbestätigt), Crunchyroll kuratierte Listen (unbestätigt) | Mittel – Sammlungen/Studios bereits vorhanden |
| Anbieter-Verfügbarkeit („wo kann ich das schauen“) | JustWatch (unbestätigt im Detail) | Gering – Bibliothek ist selbst gehostet |
| Personen-/Filmografie-Seiten mit Verlinkung aus der Besetzung | IMDb, Letterboxd, Plex (allgemein bekannt, unbestätigt in dieser Recherche) | Hoch – fehlte komplett |

### Crunchyroll im Detail

- **Watchlist & Crunchylists:** Die Watchlist ist für alle da, eigene benannte Listen (Crunchylists) gibt es mit Limits (10 Listen à 100 Titel). Auf der Titelseite gibt es eine „+ zu Liste“-Aktion, und „Meine Listen“ bietet Tabs für den Wechsel. FriendFlix hat das bereits: „Meine Liste“ und geteilte Listen mit Rollen. Darüber hinaus nichts übernommen.
- **Browse & Genre-Navigation:** Es gibt eine A–Z-Ansicht mit einem Filter-Panel. Übernommen als generisches Muster: kombinierbare Filter (Genre, Jahrzehnt, Bewertung, Person) mit sichtbaren, einzeln entfernbaren Filter-Chips, dazu einem stabilen URL-Zustand und einem Schalter Filme/Serien, der die Filter behält.
- **Dub/Sub-Filter:** Crunchyroll filtert offiziell nach synchronisierten Titeln; einen offiziellen Untertitelsprachen-Filter fanden wir nicht. Für FriendFlix wäre ein Filter nach Audio- und Untertitelsprache aus den Jellyfin-Mediastreams naheliegend. Jellyfins `/Items`-Endpunkt bietet dafür aber keinen verlässlichen Filter, deshalb bräuchte es einen eigenen Index. Das ist bewusst nicht umgesetzt, siehe unten.
- **Serien-/Episodenstruktur, Fortschritt:** Staffelwahl, Weiterschauen und „Nächste Folge“ sind in FriendFlix bereits vorhanden.
- **Mobile Browse:** Ein Filter-Icon führt zu einem Panel mit „Anwenden“. FriendFlix nutzt stattdessen native Selects, die auf 375 px umbrechen, mit Touch-Zielen ≥ 44 px. Das ist einfacher und zugänglicher als ein eigenes Panel.

## Audit-Ergebnisse (eigene Codebasis)

- **Suche:**
  - Nur Titel, keine Personen, Genres oder Jahre.
  - Netzwerkfehler wurden als „Keine Treffer“ angezeigt, mit Wunsch-CTA.
  - Kein Ladezustand, kein Abbruch veralteter Requests.
  - Jeder Tastendruck löste eine Navigation aus.
- **Browse:**
  - Race-Condition: Antworten zu alten Filtern wurden an neue Ergebnisse angehängt.
  - Ungeprüfte URL-Parameter.
  - Kein Jahr-, Bewertungs- oder Personenfilter.
  - Bibliotheksseite ohne URL-Zustand.
- **Detailseite:**
  - Besetzung nur im Player (X-Ray), nicht verlinkt.
  - Fiel eine Neben-Anfrage aus (Bewertungen, Staffeln), zeigte die Seite „Titel nicht gefunden“.
  - Toggles ohne Fehlerbehandlung.
- **Datenschutz:** `GET /api/items/:id/ratings` lieferte die Bewertungen aller Nutzer zu beliebigen IDs. Dabei wurde weder die Sichtbarkeit des Titels geprüft noch das Opt-out `shareRatings` beachtet.
- **„Gemeinsam schauen“:** Die Schnittmenge wurde vor dem Genre- und Laufzeit-Filter auf 400 Titel gekürzt. Passende Titel konnten dadurch fehlen.
- **Performance:** Kein Index auf `ratings(item_id)`. Die Genreliste wurde bei jedem Aufruf live von Jellyfin geholt.

## Entscheidung: was umgesetzt wird

Fokus auf **Finden und Entdecken**: höchster Nutzerwert bei mittlerem Aufwand, und es baut auf vorhandenen Daten auf.

1. **Gruppierte Sofortsuche:** Personen, Genres, Filme & Serien und Folgen in einer Suche. Dazu eine Jahressuche, Lade-, Fehler- und Leerzustände, das Abbrechen veralteter Requests, ein lokaler Suchverlauf und der Tastatur-Shortcut `/`.
2. **Personenseiten:** Filmografie, die auf die eigene Bibliothek beschränkt ist. Die Besetzung auf der Detailseite verlinkt dorthin.
3. **Browse-Filter:** Jahrzehnt, Mindestbewertung und Person, dazu entfernbare Filter-Chips, validierter URL-Zustand und Race-Guards.
4. **Robustheit:** Die Detailseite fällt nicht mehr auf „nicht gefunden“ zurück, wenn nur eine Neben-Anfrage scheitert. Toggles melden Fehler.
5. **Sicherheit und Korrektheit:**
   - Bewertungen respektieren Sichtbarkeit und Opt-out.
   - „Gemeinsam schauen“ filtert vor dem Kürzen.
   - Neuer Index, gecachte Genreliste.

## Nachtrag Block 7 (umgesetzt)

- Audio-/Untertitel-Sprachfilter (Crunchyroll-Muster) über einen eigenen Stream-Index, siehe `docs/discovery.md`.
- Watch-Status geplant/abgebrochen, abgeleitet „schaue gerade“/„gesehen“ (Trakt-Muster „Drop show“).
- Freunde-Leiste auf der Detailseite mit Privatsphäre je Kategorie (Plex-Muster).
- „Gemeinsam schauen“ gewichtet nach Merklisten der Teilnehmer (Letterboxd-Vergleich).

## Bewusst nicht umgesetzt (Follow-ups)

- **Audio-/Untertitel-Sprachfilter (Crunchyroll-Muster):** Braucht einen eigenen Index der Mediastreams, also einen Hintergrundjob und eine Tabelle, weil Jellyfin `/Items` das nicht zuverlässig filtert. Lohnt sich als eigener Block.
- **Watch-Status geplant/schaue/abgebrochen/gesehen (Trakt/TV-Time-Muster):** Neues Datenmodell, das mit „Meine Liste“ und „Aus Weiterschauen entfernen“ zusammengeführt werden muss. Sinnvoll gemeinsam mit einer besseren Gruppen-Empfehlung.
- **„Gemeinsam schauen“ mit Gewichtung nach Watchlists/Bewertungen:** Hängt vom Watch-Status und von Sharing-Optionen pro Profil ab.
- **Freunde-Leiste auf der Detailseite (Plex-Muster):** Braucht eine klare Privatsphäre-Regel pro Kategorie.
- **Reaktionen pro Folge nach dem Ansehen (TV-Time-Muster):** Mittlerer Aufwand, später.
- **Responsive Bilder (`srcset`) und Karten-Aktionen auf Touch-Geräten:** Eigener UI-PR, weil Card/Row zentral sind und Hover-Layout und Negativ-Margins betroffen wären.
- **CI-Verbesserungen:**
  - Tests typchecken.
  - `npm audit`-Gate.
  - Image nur einmal bauen.
  - Actions auf SHAs pinnen.

  Das sind sinnvolle Infrastruktur-Themen, aber ohne direkten Bezug zu diesem Produkt-PR.

## Quellen

- Crunchyroll Hilfe – Watchlist/Crunchylist: https://help.crunchyroll.com/hc/en-us/articles/18184740052628
- Crunchyroll Hilfe – Dub-Filter: https://help.crunchyroll.com/hc/en-us/articles/22743917983892
- Crunchyroll Hilfe – Wunschliste teilen: https://help.crunchyroll.com/hc/en-us/articles/22038469635604
- Plex – Discover Together: https://www.plex.tv/blog/discover-together/ · https://techcrunch.com/2023/11/01/plex-becomes-a-social-network-with-public-debut-of-discover-together
- Trakt – Drop Show: https://alternativeto.net/news/2025/4/trakt-tv-launches-drop-show-for-easier-watchlist-cleanup-across-all-platforms/
- Trakt – Continue/Start Watching: https://alternativeto.net/news/2025/12/trakt-rolls-out-continue-watching-and-start-watching-smart-lists-in-new-lite-design/
- Letterboxd/Moviebase – Watchlists vergleichen: https://www.popsci.com/diy/how-to-use-letterboxd/ · https://moviebase.app/resources/how-to-track-movies-and-shows-as-a-couple
- Netflix Hilfe – Suche: https://help.netflix.com/node/47765
- Netflix – Top 10: https://about.netflix.com/news/see-whats-popular-on-netflix
- TV Time: https://techcrunch.com/2018/03/12/tv-time-the-tv-tracking-app-with-over-a-million-daily-users-can-now-find-your-next-binge

Es wurden keine Texte, Bilder, Logos oder UI-Assets dieser Anbieter übernommen; umgesetzt sind generische Interaktionsmuster.
