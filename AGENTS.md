# Voice Workbench

## Projektstruktur

- src/server: lokale API, Datenzugriff und Modelladapter.
- src/shared: gemeinsame Typen, Validierung und Antwortverträge.
- app/api: Next.js-Routeneinstieg.
- db/migrations: versionierte SQL-Migrationen.
- scripts: Konfiguration, Start und Migration.
- tests: deterministische Tests mit synthetischen Daten.
- docs: Architektur und Funktionsbeschreibung.

## Entwicklung

Node.js 24 oder neuer und npm verwenden. Abhängigkeiten mit npm ci installieren.

- npm run dev: Entwicklungsserver auf 127.0.0.1:3210.
- npm run build: Produktionsbuild ohne erforderliche Zugangsdaten.
- npm start: Produktionsserver.
- npm run db:migrate: Datenbankschema aktualisieren.
- npm test: Verhaltenstests ohne externe Dienste.
- npm run typecheck, npm run lint und npm run format:check: Quellcode prüfen.
- npm run format: Quellcode, Tests und Konfiguration formatieren.

TypeScript bleibt strikt. Oberfläche und Dokumentation sind deutsch, technische Identifier englisch. Bestehende gemeinsame Schemas und Fehlerantworten verwenden.

## Daten und Konfiguration

Anwendungseinstellungen stehen ausschließlich in .env.local. Zugangs- und Plattformschlüssel dürfen weder in Git noch in Logs oder Browserartefakte gelangen. Die Anwendung bindet nur an Loopback.

Angewendete Migrationen sind unveränderlich; Schemaänderungen benötigen eine neue nummerierte SQL-Datei. LF-Zeilenenden beibehalten. Audio, temporäre Daten und lokale Prüfdateien gehören nicht in die Versionsverwaltung.

Der aktuelle Funktionsumfang steht in README.md. API- und Datenverträge stehen in docs/design/voice-workbench.md.
