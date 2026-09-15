# Voice Workbench, Version 1

Die Server-API und das Datenmodell sind implementiert. Die Abschnitte zur Aufnahme, lokalen Wiederherstellung und Oberfläche beschreiben den geplanten Client. Die Anwendung ist für lokalen Betrieb vorgesehen.

## Produktvertrag

Der Nutzer öffnet die Arbeitsfläche auf localhost:3210, nimmt einen Gedanken auf, stoppt, erhält ein Transkript, kann es optional glätten und bearbeitet die verwendbare Fassung. Titel und Text werden automatisch in einer eigenen Turso-Datenbank gespeichert. Verlauf, Texte und Vokabular sind auf dem zweiten Rechner mit derselben Projektkonfiguration verfügbar. Audio bleibt im Browserprofil des aufnehmenden Rechners. Standard: Google-Verbatim und getrennte, ausdrücklich gestartete Textverbesserung. Google-Smart kann bei der Aufnahme bewusst gewählt werden und wird als geglättete Transkription gekennzeichnet. Mistral liefert Transkription, die separate Verbesserung bleibt verfügbar.

Eine Aufzeichnung entspricht einer Notiz; zusätzliche Aufnahmen erzeugen neue Notizen. Kein Einfügen in bewegliche Cursorpositionen während einer laufenden Anfrage. Keine globalen Tastenkürzel, kein automatisches Ausführen von Spracheingaben. Kopieren und Markdown-Download sind die Übergabe.

## Referenzfälle

- R1: Deutsches Agenten-Briefing mit englischen Fachbegriffen und Negationen, Original und bearbeitbare Fassung erhalten.
- R2: Notiz am Mac erstellt, am zweiten Rechner geöffnet und bearbeitet, keine Audioverfügbarkeit dort behaupten.
- R3: API- oder Speicherfehler nach einer Aufnahme, Aufnahme beziehungsweise fertiges Resultat bleiben wiederherstellbar.
- R4: Zwei Tabs oder Rechner bearbeiten denselben Text, Konflikt wird angezeigt und beide Fassungen bleiben verfügbar.
- R5: Mikrofon verweigert, falscher Provider oder große Aufnahme, verständlicher Zustand ohne verlorene Notiz oder Endlosschleife.

## Laufzeit und Grenzen

Next.js App Router mit Node-Runtime, React/TypeScript, AI SDK mit Google/Mistral und @libsql/client. Keine ORM-Schicht für die drei kleinen Fachtabellen. Keine separate Server- oder Worker-Anwendung. Next läuft nur auf Loopback. APP_ORIGIN ist ein fester einzelner lokaler Origin, Default http://localhost:3210. dev und start verwenden 127.0.0.1:3210; Browserzugriff via konfiguriertem localhost-Origin. Lokaler Betrieb ohne Konten oder Teamfreigaben. Persönliche Daten und Konfiguration bleiben außerhalb der Versionsverwaltung. Der reguläre Alltag nutzt den Produktionsstart nach Build.

Ein projektspezifischer Node-Launcher lädt ausschließlich .env.local aus dem Produktverzeichnis mit Node parseEnv und setzt die fünf bekannten Konfigurationswerte ausdrücklich im Child-Prozess. Er entfernt TURSO_API_KEY und geerbte NEXT_PUBLIC-Werte, bevor Next gestartet wird. Zusätzliche Next-Env-Dateien und unbekannte Schlüssel in .env.local werden vor dev, start und build abgewiesen. Der Build benötigt keine Konfiguration; vorhandene echte Schlüssel werden durch gesetzte leere Werte gegen Nexts erneute Env-Auflösung abgeschirmt. Geerbte gleichnamige Variablen dürfen die Datei nicht übersteuern. Datenbank-URL/Token und APP_ORIGIN werden beim Start geprüft; Provider-Keys sind optional und ihre Verfügbarkeit wird angezeigt. Nur libsql:// oder https:// als Remote-DB-URL, keine lokale oder beliebige HTTP-Datenbank per Laufzeitkonfiguration. Fehlende Produktdatei führt zu einer konkreten Konfigurationsmeldung. Keine Secretprüfung beim statischen Build notwendig, Clients werden erst in den Routen initialisiert.

Kontrolliert weitergeleitete SIGINT-/SIGTERM-Stopps enden mit Status 0; unerwartete Fehler bleiben Fehlerabschlüsse.

Runtime-Credential ist auf diese eine Datenbank beschränkt. In Version 1 dient derselbe Token für Schema-Migrationen und Datenzugriff und besitzt damit bewusst DDL-Rechte. Das zusätzliche Recht bleibt innerhalb der isolierten persönlichen Datenbank. Kein Gruppen- oder Plattformtoken zur Laufzeit.

Server-only: Konfiguration, Datenbank, Provider-Factory und Routenhelfer. Keine Secrets in NEXT_PUBLIC, JSON-Antworten, Diagnose-Objekten oder Logs. Nur projektspezifische .env.local, niemals Konfiguration anderer Projekte implizit laden. Der Turso-Plattformschlüssel wird ausschließlich zur Provisionierung benutzt und nicht ins Produkt kopiert.

## Datenmodell

notes:
- id TEXT PRIMARY KEY, clientseitige UUID.
- title TEXT NOT NULL, maximal 160 Zeichen.
- original_text TEXT NOT NULL, unveränderliches erfolgreiches Transkript, maximal 100000 Zeichen.
- body TEXT NOT NULL, aktuelle verwendbare Fassung, maximal 100000 Zeichen.
- provider TEXT NOT NULL CHECK IN ('google','mistral').
- model TEXT NOT NULL, angeforderte API-Modellkennung aus der Registry. Eine aufgelöste Backendversion wird nicht behauptet. Die Speicherung enthält clientübermittelte Metadaten, keinen attestierten Ausführungsnachweis.
- mode TEXT NOT NULL CHECK IN ('verbatim','smart').
- duration_ms INTEGER NOT NULL CHECK >=0, vom Client gemessene Aufnahmedauer, keine Abrechnungsgrundlage.
- created_at TEXT NOT NULL, Serverzeit UTC.
- updated_at TEXT NOT NULL, Serverzeit UTC.
- revision INTEGER NOT NULL CHECK >=1.
Index auf updated_at DESC, id DESC für Verlauf.

settings:
- id INTEGER PRIMARY KEY CHECK id=1.
- vocabulary_json TEXT NOT NULL, validierte Liste von maximal 100 Begriffen, je 80 Zeichen, nicht leer nach trim, keine Kommas oder Steuerzeichen. Unicode-Normalisierung NFC, dedupliziert unter Beibehaltung der Reihenfolge. Mehrwortbegriffe bleiben gespeichert unverändert, für Mistral werden Whitespacefolgen zu Unterstrichen abgebildet; für Google werden die ursprünglichen Leerzeichen verwendet. Die UI erklärt diese Providerabbildung.
- revision INTEGER NOT NULL CHECK >=1.
Initial leer, keine persönlichen Begriffe im öffentlichen Code.

deleted_notes:
- id TEXT PRIMARY KEY, ehemalige Notiz-ID.
- deleted_at TEXT NOT NULL, Serverzeit UTC.
Nur der Löschmarker bleibt, Titel und Text werden tatsächlich gelöscht. PUT prüft den Marker vor jeder Neuanlage und antwortet 410 note_deleted. Marker werden in Version 1 nicht automatisch abgeräumt.

API-Schlüssel und geräteabhängige Einstellungen kommen nicht in die Cloud-Datenbank. Eine eigene Datenbank dient ausschließlich den Notizen und Einstellungen dieser Anwendung. Migrationen als nummerierte SQL-Dateien plus schema_migrations; Ausführung explizit vor Appstart, keine DDL im Requestpfad. Migrationen pro Datei transaktional, Versionskennung eindeutig. App startet bei fehlender Konfiguration mit verständlicher Setup-Meldung.

## Wire-Vertrag

Alle Antworten no-store. Fehler JSON {error:{code,message,issues?}} mit stabilen Codes und deutschem Text, keine rohen SDK-Exceptions. Unbekannte Felder und fehlerhafte Typen werden abgewiesen. invalid_input enthält bei Schemafehlern bis zu 20 sichere Issues {path:string[],reason:string} ohne Eingabewerte. Browserkompatible Antwort-/Fehlerschemata und Replay-/Retry-Helfer liegen in src/shared/responses.ts. UUIDs, Textgrenzen, Revisionen und enum-Werte werden serverseitig validiert. Header Content-Type wird pro Route geprüft.

GET /api/config -> {providers:[{id,label,model,available,smartMode,vocabulary}],enhancementAvailable:boolean,limits:{maxAudioBytes,maxRecordingSeconds,maxEnhanceLength}}. Keine Secretwerte, keine beliebigen auswählbaren URLs oder freien Modellnamen.

GET /api/notes?cursor=<opaque> -> {items:[{id,title,preview,provider,mode,updatedAt,revision}],nextCursor:string|null}. 50 pro Seite, preview aus body mit maximal 140 Zeichen. Cursor v1 (Base64url-JSON {v:1,updatedAt,id}, maximal 256 Zeichen), strikt kanonische UTC-ISO-Zeit und UUID, gebundene SQL-Parameter, keine SQL-Fragmente aus Eingaben. Kein Snapshot-Versprechen bei parallelen Edits; Client dedupliziert IDs und startet bei Revalidierung wieder auf Seite 1. GET /api/notes/:id -> vollständige Note mit camelCase-Feldern. Unbekannt: 404 note_not_found; bekannt gelöscht: 410 note_deleted.

PUT /api/notes/:id (JSON, höchstens 512 KiB): {title,originalText,body,provider,model,mode,durationMs}. Erstellt eine Notiz mit Revision 1. Bei Wiederholung mit derselben ID wird der unveränderliche Ursprung geprüft (originalText,provider,model,mode,durationMs). Stimmen Ursprung und ID überein, aktuelle Note zurückgeben, niemals bestehende Edits überschreiben; anderer Ursprung -> 409 id_conflict. Ursprungsvergleich, Markerprüfung und Insert laufen in einer write-Transaktion. Die Wiederholung kann eine neuere Note liefern. Bei vollständiger Gleichheit von Ursprung, Titel und Body wird Cloudsave bestätigt. Bei gleichem Ursprung, aber anderem Titel/Body wird der lokale Entwurf als Konflikt mit der zurückgegebenen Serverrevision erhalten. id_conflict oder note_deleted erlaubt ausschließlich ausdrücklich gewählte Neuanlage unter neuer UUID, niemals automatische Wiederanlage.

PATCH /api/notes/:id (JSON, höchstens 512 KiB): {title,body,expectedRevision:int>=1}. UPDATE WHERE id=? AND revision=?, revision=revision+1, RETURNING *. Erfolg anhand genau einer RETURNING-Zeile (rows.length), nicht rowsAffected. Null Zeilen -> im selben write-Transaktionskontext unterscheiden zwischen 404 und 409 revision_conflict. Konfliktantwort enthält {error:{code,message},current:Note}. Verlorene erfolgreiche Antwort kann bei Wiederholung Konflikt erzeugen; wenn current title/body der gesendeten Fassung entspricht, darf der Client sie als bestätigt erkennen. Kein automatisches Überschreiben neuerer Fassungen.

DELETE /api/notes/:id (JSON): {expectedRevision}. Bedingtes Löschen mit Revision und Anlegen eines deleted_notes-Markers in derselben write-Transaktion. Bei bereits vorhandenem Marker 204, bei unbekannter ID 404, bei anderer Revision 409 mit current. Erfolgreiches DELETE RETURNING anhand rows.length auswerten. UI fragt vor Löschen, stoppt ausstehende Saves und hält Löschzustand gesperrt. Keine Neuanlage durch Autosave nach Löschen. 204 bei Erfolg. Cloud-Löschung und lokale Audio-/Entwurfslöschung sind getrennt bestätigt. Ein Fehler beim lokalen Entfernen zeigt nach Cloud-Erfolg einen lokalen Wiederholen-Knopf. Ein PATCH 404/410 mit lokalem Entwurf bedeutet: Notiz entfernt, lokale Fassung nur kopieren/herunterladen oder ausdrücklich unter neuer UUID anlegen. Andere lokal gespeicherte Audio-Kopien werden durch Cloud-Löschen nicht automatisch entfernt.

GET /api/settings -> {vocabulary:string[],revision}. PUT /api/settings -> {vocabulary,expectedRevision}; CAS und Lost-response-Inhaltsabgleich wie Notes, 409 enthält current. Fehlende Singletonzeile ist 503 schema_unavailable. Revisionen sind positive sichere JavaScript-Integer. Ein Erreichen der maximalen Revision wird als Konflikt mit unveränderter aktueller Fassung zurückgegeben, niemals als ungenaue Zahl. Revision 1 ist initial leer. Einstellungen werden ausdrücklich gespeichert, kein Save-on-keystroke. Der Replayvergleich verwendet dasselbe getrimmte, NFC-normalisierte und deduplizierte Vokabular wie der Schreibpfad.

POST /api/transcribe (multipart, Gesamtgrenze 26 MiB): audio (File, 1..25 MiB), provider ('google'|'mistral'), mode ('verbatim'|'smart'), vocabulary (JSON Liste gemäß Settings). Unterstützte Container: webm/ogg/mp4/wav/mpeg; MIME-Essenz ohne Parameter normalisieren (x-wav -> wav, mp3 -> mpeg, m4a/x-m4a -> mp4). Genau ein audio-Part und je ein provider/mode/vocabulary-Feld; unbekannte oder doppelte Felder abweisen. Vokabularfeld maximal 32768 Bytes. Der anwendungseigene Format-Guard verwendet dieselbe öffentliche detectMediaType-Funktion aus der direkt deklarierten SDK-Hilfsbibliothek wie die anschließende Transkription. Eine zusätzliche Whitelist begrenzt auf die fünf Produktformate. Kanonische Signatur muss zur MIME-Klasse passen; Unbekanntes wird vor dem SDK abgewiesen, da dessen Fallback sonst WAV annimmt. Keine Codec-, Audiospur- oder Dauerdekodierung: Die Containerprüfung ist keine vollständige Medienvalidierung, der feste Provider validiert die Audiospur. Dies ist eine bewusste Grenze des persönlichen Aufnahme-Workflows. Maximal 600 Sekunden UI-Aufnahme, ausdrücklich keine serverseitig nachgemessene Dauer- oder Kostenzusage. Serverseitig gelten 25*1024*1024 Audio-Bytes, 26*1024*1024 Gesamtbytes, 20 Sekunden absolute Body-Lesezeit und 120 Sekunden Providerzeit. Global pro Next-Prozess maximal zwei aktive Modellrequests einschließlich Bodyannahme; keine Warteschlange, weitere Anfragen 429 busy. Die lokale Antwortfrist wird unabhängig vom kooperativen Upstream-Abbruch erzwungen. Ein verspätet endender SDK-Aufruf behält seinen Slot bis zum tatsächlichen Ende. Bei dauerhaft hängenden SDK-Aufrufen kann ein Serverneustart nötig sein; ein lokaler Timeout gibt keinen zusätzlichen unbegrenzten Aufruf frei. Dies ist keine kontoweite Quote über mehrere Rechner. Kein freier Remote-URL-Import. Mistral + smart -> 400 unsupported_mode. Fehlender Provider-Key -> 503 provider_unavailable. Erfolg -> {text,provider,model,mode}; text wird getrimmt, maximal 100000 Zeichen; leerer Text -> 422 no_transcript, zu großer Text -> 502 output_too_large. SDK-Fehler ohne Text -> 502 transcription_failed. Die Modelle sind fest: Google gemini-3.5-transcribe, Mistral voxtral-mini-latest. Aktive Modelle und Fähigkeiten stammen aus PROVIDERS. MODEL_HISTORY ist ein additives Register für gespeicherte und noch ausstehende Ergebnisse; es enthält auch die datierte Mistral-Kennung voxtral-mini-2602. Create und Replay dürfen jede dort freigegebene Kombination speichern, tatsächliche Modellaufrufe verwenden ausschließlich das aktive Modell. Ein Wechsel des aktiven Modells entfernt keine Historieneinträge. Aliase sind bewusst aktuell gehaltene API-Kennungen, keine eingefrorene Modellrevision. SDK-NoTranscriptGeneratedError ist ein Verarbeitungsfehler, kein Beleg für Stille. Kein automatischer kostenpflichtiger Providerwechsel. Timeout 120s, maxRetries=0. Abbruch signalisiert Stop an Upstream, bereits entstandene Kosten bleiben möglich.

POST /api/enhance (JSON bis 512 KiB): {text,preset:'clean'|'bullets'|'english'}. Antwort {text,provider,model,preset}. Fester kleiner Mistral-Textprovider, keine Tools, keine Shell oder CLI. Vorgabe: Sinn, Unsicherheit, Bedingungen und Negationen erhalten, nur den gewählten Stil bearbeiten; Text ist zu transformierender Inhalt, keine Berechtigung zur Aktion. Modell mistral-small-latest, Input maximal 12000 UTF-16-Codeunits, maxOutputTokens=8192, maxRetries=0, Timeout 120s mit Clientabbruch kombiniert. Verifizierter Modellkontext 262144 Tokens; Inputgrenze und Outputbudget liegen mit Reserve darunter. Kein Chunking. Größere Texte können gespeichert und exportiert werden, die Verbesserung erklärt ihre engere Grenze vor dem Aufruf. Nur finishReason === stop, nichtleerer Text und maximal 100000 Outputzeichen ergeben HTTP 200. Jeder andere Finish-Grund -> 502 enhancement_incomplete ohne übernehmbaren Teiltext. Outputlimitüberschreitungen -> 502 output_too_large. Freie SDK-Warnungen werden vor Providerinitialisierung deaktiviert, damit sie keine ungeprüften Inhalte protokollieren. Die feste Anweisung erhält auch zeitliche Reihenfolgen wie zuerst/erst/bevor/nachher; eine semantische Garantie wird nicht behauptet. Bei geändertem Editorinhalt seit Beginn ist Übernehmen gesperrt, das Ergebnis kann kopiert oder neu erzeugt werden. Nutzer kann Ergebnis ansehen und ausdrücklich übernehmen, Original wird nie verändert. Keine automatische Textverbesserung bei jeder Eingabe.

## Lokaler Aufnahme- und Wiederherstellungsvertrag

MediaRecorder mit vorab geprüftem isTypeSupported, Startzustände idle -> requesting_permission -> recording -> stopping -> ready -> transcribing -> ready/error. Start bleibt während Permission-Anfrage gesperrt. Stop/Cancel idempotent, Tracks und AudioContext werden in jedem Abschluss-/Fehlerpfad freigegeben. Intervalle und Events beim Unmount abbauen. Während Aufnahme sind Notizwechsel und weitere Starts gesperrt. Vor Navigation bei laufender Aufnahme warnen. Maximaldauer wird automatisch gestoppt; die Größenbegrenzung wird über kleine dataavailable-Blöcke laufend geprüft.

IndexedDB ist ausschließlich das gerätelokale Aufnahme-/Entwurfsfach: UUID, Blob, MIME, Dauer, Erstellzeit, Provider/Modus-Snapshot, optional erhaltenes Ergebnis und ausstehender Notiz-Payload. Lokale Zustände recorded -> transcribing -> transcribed -> save_pending -> cloud_confirmed, mit error/unknown und conflict als benannten Abzweigungen. Ein nach Neustart gefundenes transcribing bedeutet Ausgang unbekannt, nur manueller neuer Modellaufruf. Zustand und notwendiger Payload werden zusammen in einer IndexedDB-Transaktion geschrieben. Gesichert heißt transaction.oncomplete, nicht nur put. Fertige Aufnahme wird dort bestätigt gespeichert, bevor Upload startet. Schlägt die Speicherung fehl, bleibt der Blob im Arbeitsspeicher verfügbar; UI verlangt Audio herunterladen oder erneutes lokales Speichern. Kein Upload aus einem vermeintlich gesicherten Zustand.

Ergebnis einer Transkription zuerst lokal sichern, dann PUT in Turso. Turso-Ausfall bedeutet 'Auf diesem Gerät gesichert', nie 'Gespeichert'. Wiederholen einer DB-Speicherung verwendet dieselbe ID und erzeugt keine zweite Notiz. Nach Tabneustart ausstehende Aufnahme/Resultate anbieten. Bei unklarem Abbruch einer Modellanfrage manuelle Wiederholung mit Hinweis auf erneuten Modellaufruf; kein Exactly-once-Kostenversprechen. Laufende Aufnahme überlebt einen Browserabsturz nicht garantiert; abgeschlossene lokal bestätigte Aufnahmen schon innerhalb der Browser-Speichergrenzen. Browserdatenlöschung entfernt dieses Fach. Audio über expliziten Knopf löschen/herunterladen, keine unbemerkte Löschung nach Kopieren.

Lokale Editorentwürfe haben eigene draftId und editorInstanceId je neuer Dokumentinstanz, nie nur noteId als Schlüssel. Damit teilen zwei Tabs weder Entwurf noch laufende Speicherung. Nach Neustart werden mehrere erhaltene Entwürfe getrennt angeboten. Ein expliziter Restore sperrt nicht andere Tabentwürfe und schreibt in die neue Instanz.

Cloud-Edits: Debounce 700 ms, maximal ein PATCH je Note gleichzeitig. Während Request weitere Edits puffern, nach Erfolg nächste Fassung mit neuer Revision senden. Lokaler Entwurf mit baseRevision persistent, bevor Save startet. Veraltete Antworten ändern keine fremde aktive Notiz. Tabwechsel wartet nicht auf Netz, lokaler Entwurf bleibt. Vor Browsernavigation warnen, wenn lokales Schreiben oder Cloudsave aussteht. Konfliktpanel zeigt lokale und Serverfassung und erlaubt Kopieren sowie explizites Übernehmen einer gewählten Fassung auf Basis der aktuellen Revision. Kein stiller Last-write-wins. Bei erneutem 409 während Konfliktauflösung bleibt die lokale beziehungsweise zusammengeführte Fassung bestehen; nur die Serverseite aktualisiert sich.

Bibliothek und aktive Notiz revalidieren beim Start, Notizöffnen, Rückkehr zu visible und über einen manuellen Aktualisieren-Knopf. Höhere Serverrevision nur bei sauberem Editor übernehmen; bei abweichendem lokalem Entwurf als Konflikt anzeigen. Laufender Save wird zuerst abgeschlossen und die Revalidierung dann erneut eingeordnet.

Client-Retries: Modell-POSTs niemals automatisch. Daten-GETs höchstens ein automatischer Retry bei Netz/5xx. PUT/PATCH höchstens ein Retry bei Netz/5xx mit identischen IDs, Payload und Revision, danach sichtbarer manueller Zustand. 4xx, 409, 410, 429 und Timeouts sind manuell zu behandeln. Wiederholung von Settings und DELETE folgt derselben endlichen Regel. Keine Endlosschleifen oder automatischer Wechsel des Providers.

## Lokaler Zugriffsschutz

Ein zentraler Request-Guard läuft vor Bodylesen oder Provider/DB-Zugriff für alle API-Routen. Exakter Host-Abgleich mit APP_ORIGIN, keine weitergeleiteten Hostheader als Autorität. Wenn Origin vorhanden, exakt gleich APP_ORIGIN. Bei Schreiboperationen Origin erforderlich, ferner fester X-Voice-Workbench: 1 Header. Cross-site Fetch-Metadaten ablehnen. Keine CORS-Freigabe, OPTIONS nicht freigeben. GET mit fremdem Origin ebenfalls ablehnen. JSON-Ausgabe und React-Textdarstellung, kein HTML aus Transkripten rendern. CSP/Frame-Ancestors zum Einbettungsschutz, no-store und nosniff. Vertraute lokale Prozesse haben Zugriff; dies ist keine Mehrbenutzer-Sicherheitsgrenze und kein Betrieb auf 0.0.0.0. Ein Netzdeployment verlangt eigenständigen Auth-Vertrag.

APP_ORIGIN einmal als URL parsen: nur http, loopback-Hostname, ausdrücklich angegebener Port, keine Zugangsdaten, Query oder Fragment. Hostheader wird mit URL.host verglichen, Origin mit URL.origin; mehrdeutige/comma-getrennte Angaben abweisen. Fehlende Fetch-Metadaten sind bei ansonsten gültigem Request erlaubt; vorhandenes cross-site abweisen, same-site nur mit exakt passendem Origin. Anfragemethoden pro Route ausdrücklich erlauben, OPTIONS liefert keine CORS-Header. Guard-Abdeckung über alle API-Einstiege als Testinvariante. Build und öffentliche Repo-Dokumentation sind selbsttragend.

Bodygrenzen beim Lesen des Request-Streams zählen, nicht nur Content-Length vertrauen. Zusätzlich maximal 65536 Chunks pro Request. Multipart wird einmal aus dem begrenzten Stream durch den nativen Parser gelesen; FormData und File bleiben im kurzen Parser-Scope, zum Modell gelangt nur die Audio-Repräsentation. Kein zusätzlicher vollständiger Requestpuffer vor dem Parser; keine ungeprüften Anbieter-Fehlermeldungen oder Header loggen. Feste Providerhosts, kein SSRF-fähiger URL-Parameter. Serverseitig generierte Request-ID, Methode/Routenname, Status, Dauer und abstrakter Fehlercode bilden die Log-Positivliste. Keine Inhalte oder Anbieter-/DB-Fehlerobjekte. UI- und API-Header: frame-ancestors none, nosniff, Referrer-Policy no-referrer; API immer no-store. Produktions-CSP erlaubt ausschließlich erforderliche eigene Skripte/Styles (Next-Inlinecode mit Nonce), connect-src self, media-src self blob, img-src self data blob, object-src none, base-uri self. Dev darf für HMR eng begrenzt erweitert werden; Produktionspolicy wird im Browser geprüft.

Export: Clipboard ausschließlich text/plain nach Klick, Erfolg erst nach fulfilled Promise. Markdown UTF-8, Dateiname maximal 80 ASCII-Zeichen aus Titel-Slug, feste .md-Endung, keine Pfadtrenner/Steuerzeichen. Frontmatterwerte über JSON-quotierte YAML-Strings, created, tags und related konsistent. Rohtext wird nicht als HTML gerendert, Darstellung in externen Markdown-Programmen liegt außerhalb der Anwendung.

## Fehlerklassen und Clientreaktion

| Ursache | HTTP / Code | Reaktion |
|---|---|---|
| Host/Origin/Fetch-Guard | 403 forbidden_origin | Kein automatischer Retry, Konfiguration anzeigen. |
| Projektkonfiguration ungültig | 503 configuration_unavailable | Lokale Datei korrigieren, keine Werte ausgeben. |
| Request vom Client abgebrochen | 408 request_aborted | Daten behalten, Modellaufruf nur manuell wiederholen. |
| Methode unbekannt | 405 method_not_allowed | Kein Retry. |
| Falscher Content-Type | 415 unsupported_content_type | Eingabe korrigieren. |
| Unbekannte/ungültige Felder | 400 invalid_input | Feldfehler anzeigen, Zustand behalten. |
| Zu viele Body-Chunks | 413 request_too_fragmented | Manuell erneut übertragen. |
| Zu großer Body / Audio | 413 request_too_large / audio_too_large | Audio behalten, Download anbieten. |
| Body-Lesezeit | 408 request_timeout | Manuelles Wiederholen. |
| Unpassendes Audioformat | 415 unsupported_audio | Audio behalten, kein Uploadretry. |
| Modus nicht unterstützt | 400 unsupported_mode | Auswahl korrigieren. |
| Provider-Key fehlt | 503 provider_unavailable | Aufnahme behalten, Konfiguration prüfen. |
| Provider meldet Authfehler | 502 provider_auth_failed | Kein Retry ohne Konfigurationsänderung. |
| Lokale Parallelgrenze / Provider-Rate-Limit | 429 busy / provider_rate_limited | Später manuell wiederholen. |
| Modellzeitlimit | 504 provider_timeout | Ausgang kann unbekannt sein, manuell neuer Modellaufruf. |
| Kein verwendbares Transkript | 422 no_transcript | Kein Stillenachweis, Audio bleibt. |
| SDK/Providerfehler | 502 transcription_failed / enhancement_failed | Manueller Versuch, Daten bleiben. |
| Unvollständige / zu große Ausgabe | 502 enhancement_incomplete / output_too_large | Keine Übernahme, Eingabe bleibt. |
| Enhancementinput zu lang | 400 enhancement_input_too_long | Text unverändert, engere Grenze erklären. |
| Datenbank oder Schema nicht erreichbar | 503 storage_unavailable / schema_unavailable | Lokal gesichert anzeigen, begrenzter DB-Retry. |
| Notiz unbekannt / gelöscht | 404 note_not_found / 410 note_deleted | Entwurf behalten, nur ausdrücklich neue ID anlegen. |
| Ursprung / Revision kollidiert | 409 id_conflict / revision_conflict | Beide Fassungen erhalten, Entscheidung. |
| Unerwarteter Appfehler | 500 internal_error | Abstrakte Meldung, Zustand behalten. |

Alle deklarierten API-Routen verwenden diese Fehlerform, auch bei früher Ablehnung. Für unbekannte /api-Pfade gemeinsamer Catch-all mit 404 api_not_found. HEAD-Antworten haben transportbedingt keinen Body; nicht von Next unterstützte HTTP-Methoden können bereits im Framework abgewiesen werden. Unkontrollierbare Verbindungsabbrüche können naturgemäß keine JSON-Antwort garantieren. Keine Rückgabe eines partiellen Modelltexts bei Fehlerstatus. Konfigurationsfehler laufen durch dieselbe Request-ID-, Header- und Log-Erzeugung, bevor irgendein fachlicher Zugriff möglich ist.

Permissionfehler -> idle mit Meldung und neu nutzbarem Start. Recorderfehler nach ersten Chunks -> Audio-Rettungszustand, nicht leeres idle. Stop bei Byte-Sicherheitsreserve von 24 MiB; finalen Blob vor Upload nochmals prüfen, bei >25 MiB nur Download/Löschen. IndexedDB-Datensätze bei Restore schema-validieren; Persistent-Storage-Anfrage kann Speicherbeständigkeit verbessern, ist kein Backupversprechen. Audioverlust bei Profilbereinigung bleibt dokumentierte Grenze.

## Visueller Vertrag

Ruhige Schreibfläche, klarer weißer Editor, kühle hellgraue Bibliothek links, kräftiges Kobaltblau ausschließlich für primäre Aktionen. Desktop: 272px Verlauf plus flexible Arbeitsfläche; aktuelle Notiz und Bearbeitungsstatus im Kopf, Original als aufklappbarer Bereich, verwendbarer Text als Hauptfläche. Aufnahme-Steuerung dauerhaft erreichbar am unteren Rand. Keine Marketing-Hero, keine dekorativen Bilder. Leerer Zustand lädt mit einem klaren Aufnahmebutton ein.

Mobil: Verlauf über beschrifteten Drawer-Button, volle Schreibbreite, Aufnahmeleiste ohne verdeckte Textenden, dieselben Kernaktionen. Tastaturfokus sichtbar, Escape beendet Dialoge, keine unbeschrifteten Iconaktionen. Systemschrift, Text 17px/1.65, Labels mindestens 14px, Metadaten 12px. Tokens für Abstände, Radius, Farben. Subtile Bewegung nur bei Zustand/Listenaufbau; reduced-motion beachten. Status 'Aufnahme', 'Wird transkribiert', 'Auf diesem Gerät gesichert', 'Gespeichert', 'Konflikt' sind explizit.

## Bekannte Grenzen

Online-Cloud-Speicherung; kein allgemeiner Offline-Sync. Audio pro Browserprofil. Keine Authentifizierung gegen andere Prozesse desselben Rechners. Kein SDK-Fehler darf zu scheinbar erfolgreicher leerer Notiz werden. Keine garantierte Kosteneinmaligkeit eines unterbrochenen Modellaufrufs. Keine Eignung für stundenlange Meetings. Kein automatisch gestarteter Agentenauftrag.
