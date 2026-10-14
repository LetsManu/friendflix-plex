# Streaming product research – discovery upgrade

Stand: Oktober 2026. Ziel: Muster etablierter Streaming-, Tracking- und Social-Produkte finden, die für FriendFlix (selbst gehostet, Jellyfin + Wunsch-Dienst, kleiner Freundeskreis) echten Nutzen bringen – ohne Marken, Texte, Bilder oder proprietäre Oberflächen zu übernehmen.

Methodik: öffentliche Hilfeseiten, Produkt-Blogs und Fachartikel (Quellen unten), plus ein Audit der eigenen Codebasis (Frontend, Backend, Qualität/CI). Was nicht direkt in einer Quelle bestätigt werden konnte, ist als „unbestätigt“ markiert.

## Beobachtete Muster

| Muster | Wo gesehen | Relevanz für FriendFlix |
|---|---|---|
| Suche nach Titel, Genre **und Person**, Ergebnisse nach Art eingrenzbar | Streaming-Dienste (Hilfeartikel zur Suche) | Hoch – FriendFlix suchte nur nach Titeln |
| Browse mit Filter-Steuerung (z. B. Sprache/Dub), auf Mobil per Filter-Icon + „Filter anwenden“ | Anime-Dienste (Hilfe: Dub-Filter) | Hoch für Filter; Sprachfilter siehe „nicht umgesetzt“ |
| Standard-Watchlist plus benannte eigene Listen, Status „in Liste“ auf der Titelseite | Anime-Dienste (Watchlist + benannte Listen), Tracking-Apps | Bereits vorhanden (Merkliste + geteilte Listen) |
| Freunde-Aktivität und „Freunde haben das gesehen/bewertet“ auf der Titelseite, Sichtbarkeit pro Kategorie (privat/Freunde) | Medienserver-Apps („Gemeinsam entdecken“) | Teilweise vorhanden (Bewertungen, Empfehlungen) – Privatsphäre-Opt-out muss überall greifen |
| Watchlists zweier Personen vergleichen (Schnittmenge) | Letterboxd | Vorhanden als „Gemeinsam schauen“ (/match) |
| Serie „abbrechen“: verschwindet aus Weiterschauen/Kalender, Verlauf bleibt | Tracking-Apps („Serie abbrechen“) | Teilweise vorhanden („Aus Weiterschauen entfernen“) |
| Reaktionen pro Folge erst nach dem Ansehen sichtbar (Spoiler-Gate) | Tracking-Apps (ältere Quellen) | Mittel – passt zu vorhandenem Spoiler-Schutz |
| Tägliche Top-10-Reihe mit Rang-Badge | Streaming-Dienste | Vorhanden („Top bei uns“-ähnliche Reihen) |
| Mood-/Themen-Hubs, kuratierte Sammlungen | Streaming-Dienste (unbestätigt), kuratierte Listen bei Anime-Diensten (unbestätigt) | Mittel – Sammlungen/Studios bereits vorhanden |
| Anbieter-Verfügbarkeit („wo kann ich das schauen“) | JustWatch (unbestätigt im Detail) | Gering – Bibliothek ist selbst gehostet |
| Personen-/Filmografie-Seiten mit Verlinkung aus der Besetzung | Film-Datenbanken, Film-Communities, Medienserver-Apps (allgemein bekannt, unbestätigt in dieser Recherche) | Hoch – fehlte komplett |

### Anime-Dienste im Detail

- **Watchlist & benannte Listen:** Die Watchlist ist für alle da, eigene benannte Listen gibt es mit Limits (10 Listen à 100 Titel). Auf der Titelseite gibt es eine „+ zu Liste“-Aktion, und eine Listenübersicht bietet Tabs für den Wechsel. FriendFlix hat das bereits: „Merkliste“ und geteilte Listen mit Rollen. Darüber hinaus nichts übernommen.
- **Browse & Genre-Navigation:** Es gibt eine A–Z-Ansicht mit einem Filter-Panel. Übernommen als generisches Muster: kombinierbare Filter (Genre, Jahrzehnt, Bewertung, Person) mit sichtbaren, einzeln entfernbaren Filter-Chips, dazu einem stabilen URL-Zustand und einem Schalter Filme/Serien, der die Filter behält.
- **Dub/Sub-Filter:** Anime-Dienste filtern offiziell nach synchronisierten Titeln; einen offiziellen Untertitelsprachen-Filter fanden wir nicht. Für FriendFlix wäre ein Filter nach Audio- und Untertitelsprache aus den Jellyfin-Mediastreams naheliegend. Jellyfins `/Items`-Endpunkt bietet dafür aber keinen verlässlichen Filter, deshalb bräuchte es einen eigenen Index. Das ist bewusst nicht umgesetzt, siehe unten.
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
  - Besetzung nur im Player (Info-Overlay), nicht verlinkt.
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

- Audio-/Untertitel-Sprachfilter (Anime-Dienst-Muster) über einen eigenen Stream-Index, siehe `docs/discovery.md`.
- Watch-Status geplant/abgebrochen, abgeleitet „schaue gerade“/„gesehen“ (Muster „Serie abbrechen“).
- Freunde-Leiste auf der Detailseite mit Privatsphäre je Kategorie (Muster von Medienserver-Apps).
- „Gemeinsam schauen“ gewichtet nach Merklisten der Teilnehmer (Letterboxd-Vergleich).

## Bewusst nicht umgesetzt (Follow-ups)

- **Audio-/Untertitel-Sprachfilter (Anime-Dienst-Muster):** Braucht einen eigenen Index der Mediastreams, also einen Hintergrundjob und eine Tabelle, weil Jellyfin `/Items` das nicht zuverlässig filtert. Lohnt sich als eigener Block.
- **Watch-Status geplant/schaue/abgebrochen/gesehen (Muster von Tracking-Apps):** Neues Datenmodell, das mit „Merkliste“ und „Aus Weiterschauen entfernen“ zusammengeführt werden muss. Sinnvoll gemeinsam mit einer besseren Gruppen-Empfehlung.
- **„Gemeinsam schauen“ mit Gewichtung nach Watchlists/Bewertungen:** Hängt vom Watch-Status und von Sharing-Optionen pro Profil ab.
- **Freunde-Leiste auf der Detailseite (Muster von Medienserver-Apps):** Braucht eine klare Privatsphäre-Regel pro Kategorie.
- **Reaktionen pro Folge nach dem Ansehen (TV-Time-Muster):** Mittlerer Aufwand, später.
- **Responsive Bilder (`srcset`) und Karten-Aktionen auf Touch-Geräten:** Eigener UI-PR, weil Card/Row zentral sind und Hover-Layout und Negativ-Margins betroffen wären.
- **CI-Verbesserungen:**
  - Tests typchecken.
  - `npm audit`-Gate.
  - Image nur einmal bauen.
  - Actions auf SHAs pinnen.

  Das sind sinnvolle Infrastruktur-Themen, aber ohne direkten Bezug zu diesem Produkt-PR.

## Quellen

- Öffentliche Hilfe-Center-Artikel großer Streaming-Dienste und Medienserver-Apps (Stand der Recherche, nicht einzeln verlinkt).
- Tracking-App – Drop Show: https://alternativeto.net/news/2025/4/trakt-tv-launches-drop-show-for-easier-watchlist-cleanup-across-all-platforms/
- Tracking-App – Continue/Start Watching: https://alternativeto.net/news/2025/12/trakt-rolls-out-continue-watching-and-start-watching-smart-lists-in-new-lite-design/
- Letterboxd/Moviebase – Watchlists vergleichen: https://www.popsci.com/diy/how-to-use-letterboxd/ · https://moviebase.app/resources/how-to-track-movies-and-shows-as-a-couple
- Tracking-App (Episodenverfolgung): https://techcrunch.com/2018/03/12/tv-time-the-tv-tracking-app-with-over-a-million-daily-users-can-now-find-your-next-binge

Es wurden keine Texte, Bilder, Logos oder UI-Assets dieser Anbieter übernommen; umgesetzt sind generische Interaktionsmuster.
