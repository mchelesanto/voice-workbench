# ADR 0001: Lokales Next.js mit gemeinsamer Turso-Datenbank

Status: angenommen, Serverteil implementiert. Die Oberfläche folgt separat.

## Kontext

Die Anwendung soll auf mehreren Rechnern lokal nutzbar sein und Notizen gemeinsam speichern. Eine Browseroberfläche und serverseitige Modellaufrufe lassen sich in einer Next.js-Anwendung betreiben.

## Entscheidung

Next.js mit Node-Routen, Google/Mistral über AI SDK, Turso mit serverseitigem @libsql/client. Neue Datenbank und auf sie begrenzter Token. SQL-Migrationen statt ORM. Notizen mit unveränderlichem Transkript, bearbeitbarer Fassung und optimistischer Revision. IndexedDB als lokales Wiederherstellungsfach für Audio und noch nicht synchronisierte Entwürfe. Kein Plattformschlüssel im Produkt.

## Alternativen und Kosten

- Nur localStorage: geringer Aufwand, erfüllt Rechnerwechsel und Audio-Retry nicht.
- Lokale Datenbank plus bidirektionaler Sync: ermöglicht Offlinebearbeitung, führt Konflikt- und Wiederabgleichssemantik ein, für den Online-Schnitt unnötig.
- Separater Backend-Dienst: zusätzlicher Betrieb ohne notwendigen eigenständigen Geschäftsprozess.
- Native App: ermöglicht globale Hotkeys und lokale Modelle, erhöht Plattformumfang gegenüber ausdrücklich gewünschtem Next.js.

## Begründung und überprüfbare Eigenschaften

Die eigene Anwendung hält Audioaufnahme, Modellverarbeitung und Notizspeicherung getrennt. So bleibt eine fertige Aufnahme bei Netzfehlern verfügbar, ohne eine zweite Serveranwendung einzuführen. Die gemeinsame Cloud-Datenbank erfüllt den Rechnerwechsel mit normalen Reads/Writes. Optimistische Revisionen erkennen konkurrierende Edits; getrennte lokale Editorentwürfe bewahren beide Fassungen. Löschmarker verhindern die Wiederanlage durch verspätete Erstellungswiederholungen. Nur Datenbankzugriff auf die eigene Datenbank ist zur Laufzeit notwendig.

Modellkennungen sind deklarierte API-Kennungen; Aliase können beim Anbieter auf neue Revisionen zeigen. Metadaten sind keine attestierten Ausführungsbelege. Containerprüfung, Byte- und Zeitlimits bilden die Ressourcengrenze; eine Audiodauerdekodierung findet nicht statt. Die lokale Anwendung ist für einen Nutzer mit kurzen Aufnahmen ausgelegt.

## Revisionsauslöser

Systemweite Eingabe wird wichtig -> nativen Begleiter gesondert entscheiden. Regelmäßige Offlinearbeit -> lokalen Datenbestand und Konfliktvertrag entwerfen. Öffentlicher Netzbetrieb -> Auth, Quotas und Uploadbetrieb neu prüfen. Zusätzliche Provider dürfen Fähigkeiten deklarieren, keine UI-Schalter still ignorieren.

Referenzfälle und konkreter Wire-/Fehlervertrag: ../design/voice-workbench.md.
