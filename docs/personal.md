# Persönlich & Handy (Block 17 / S1)

## Themenlisten

Jede Liste kann von ihrer Besitzerin / ihrem Besitzer zur **Themenliste** gemacht werden (Liste öffnen → „Umbenennen“ → „Als Themenliste gestalten“): Titel, Beschreibung, optionales Emoji und eine Titelfarbe (feste Palette, `#rrggbb`). Gespeichert in `lists.themed / emoji / cover_color` (Migration 33). Die Seite `/lists/[id]` zeigt dann einen redaktionellen Kopf (Farbverlauf, großer Titel, Beschreibung) über dem Raster.

Admins (Hauptprofil) heften Themenlisten auf `/lists` unter „Themenlisten auf der Startseite“ an oder ab und sortieren sie (`featured_pos`). Angeheftet heißt `featured_at is not null` – das Limit `MAX_FEATURED` (5) gilt gemeinsam mit den „hervorgehobenen Listen“ aus `/admin/lists`. Hervorgehobene Listen, die auch Themenliste sind, erscheinen nur noch als Themenreihe, nicht doppelt.

| Route | Zugriff | Zweck |
| --- | --- | --- |
| `GET /api/lists/themed` | jedes Profil, **auch Kinderprofile** | angeheftete Themenlisten für die Startseite (`<ThemedListRows />`); Titel nur, soweit die Person sie sehen darf; leere Listen entfallen; Kinder bekommen keine Personennamen |
| `GET /api/lists/:id` | Mitglieder; angeheftete Listen als Gast; Kinderprofile nur angeheftete Themenlisten (ohne Mitglieder, Notizen, „hinzugefügt von“) | |
| `PATCH /api/lists/:id` | Besitzer | `themed`, `emoji`, `coverColor` zusätzlich zu Name/Beschreibung |
| `GET /api/lists/themed/manage` | Admin | alle Themenlisten mit Anheft-Status |
| `PUT /api/lists/:id/pin` `{ pinned }` | Admin | an-/abheften (Audit `list.feature` / `list.unfeature`), 409 `not_themed` / `too_many_featured` |
| `PUT /api/lists/themed/order` `{ ids }` | Admin | Reihenfolge der angehefteten Listen (Audit `list.themed_order`) |

## Ruhiger Modus

Profil-Einstellung `calm` (`PUT /api/prefs`, Einstellungen → „Ruhiger Modus“, auch für Kinderprofile). Eine gemeinsame Prüfung, `calmMode()` / `autoplayAllowed()` in `web/src/lib/preview.ts`:

- `playPreview()` startet im ruhigen Modus nichts (Billboard-Trailer, Hover-Vorschau, Vorschau der Detailansicht) – nur ein ausdrücklicher Klick (`explicit = true`, „Trailer abspielen“) spielt noch.
- `autoStartAllowed()` (`detail/autostart.ts`) kennt `calm`.
- `html.calm` (gesetzt in `web/src/lib/stores.ts`) dämpft alle CSS-Animationen und Übergänge, wie `prefers-reduced-motion`; das System-Setting wird zusätzlich über `motionAllowed()` beachtet.

- Das Marken-Intro beim Kaltstart entfällt im ruhigen Modus (wie bei `prefers-reduced-motion`). Weil `/api/prefs` erst danach antwortet, merkt sich der Browser den Wert je Profil (`localStorage` `ff_calm:<profil>`, `cachedCalm()` in `stores.ts`, bei jedem Laden/Speichern aktualisiert); ohne diese Kopie (erster Besuch auf dem Gerät) wird ein laufendes Intro abgebrochen, sobald die Einstellungen `calm` melden. Das Intro nach der Profilwahl zeigt dann nur die ruhige Überblendung.

Neue Dinge, die von selbst abspielen oder sich bewegen, müssen `autoplayAllowed()` bzw. `motionAllowed()` fragen.

## Klang im Player („Klare Stimmen“ / „Nachtmodus“)

Profil-Einstellung `audioFx` (`'off' | 'voices' | 'night' | 'both'`, beide Modi lassen sich kombinieren). Sie hat einen eigenen Endpunkt `PUT /api/prefs/audiofx` (der Schalter im Audio-Menü des Players); ein volles `PUT /api/prefs` (Einstellungsseite) ändert sie nie. Der Browser hält eine Kopie je Profil (`localStorage` `ff_audiofx:<profil>`), damit der Player schon vor `/api/prefs` im richtigen Modus startet; danach gilt der Serverwert, solange im Player nicht umgeschaltet wurde.

## Handy: Verknüpfungen, Symbol-Badge, Widgets

- **App-Verknüpfungen und Manifest in der Sprache des Profils:** Das Manifest ist keine statische Datei mehr, sondern die Route `/manifest.webmanifest` (`web/src/routes/manifest.webmanifest/+server.ts`, Inhalt in `web/src/lib/manifest.ts`). Name, Beschreibung und die `shortcuts` – Weiterschauen, Meine Liste, Suche, Downloads (+ Fernbedienung) – kommen aus den Übersetzungen (Bereiche `common`, `home`, `shell`, `mine`), `lang` ist gesetzt. Gewählt wird die Sprache mit `?lang=<de|en|fr|es|it|tr|pl>`, sonst nach `Accept-Language` (mit q-Werten), sonst Deutsch; der Root-Layout schreibt `<link rel="manifest">` auf `?lang=<Oberflächensprache>` um, die Antwort ist 5 Minuten cachebar (`Vary: Accept-Language`). Android zeigt die ersten vier Verknüpfungen beim langen Druck auf das App-Symbol. Wann ein bereits installierter Eintrag das neue Manifest übernimmt, bestimmt der Browser.
- **Symbol-Badge** (Badging API, installierte PWA auf Android/Desktop; iOS erst ab installierter Web-App mit Push): Zahl der ungelesenen Benachrichtigungen (Neue Folgen gefolgter Serien kommen als Benachrichtigung). Gesetzt von der App beim Start und beim Zurückkehren in den Vordergrund (`web/src/lib/badge.ts`, `syncBadge`) und vom Service Worker bei jedem Push (`updateBadge` in `web/src/lib/sw/push.ts`: Zahl der noch angezeigten Mitteilungen). Wo die API fehlt, passiert nichts.
- **Widgets**: PWA-Widgets (Web App Manifest `widgets` + Service-Worker-Ereignisse) gibt es nur unter Windows 11 (Edge, Widgets-Board). Android/iOS-Widgets setzen eine native App voraus. Deshalb sind keine Widgets enthalten; Verknüpfungen und Badge sind der Ersatz.
