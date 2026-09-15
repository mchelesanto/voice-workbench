# Voice Workbench

Eine persönliche Arbeitsfläche für Spracheingabe, überprüfbare Textverbesserung und Notizen auf mehreren Rechnern.

## Projektstand

Die API für Notizen, Transkription und Textverbesserung ist implementiert. Die Aufnahme- und Bearbeitungsoberfläche befindet sich noch in Entwicklung; die Startseite enthält noch keine Benutzeroberfläche. Es ist noch kein vollständiges Release verfügbar.

## Voraussetzungen und Einrichtung

Node.js 24 oder neuer und npm. Eine eigene Turso-Datenbank und mindestens ein Transkriptionsanbieter sind für die spätere vollständige Nutzung erforderlich.

### Zugangsdaten vorbereiten

Eine neue Datenbank im eigenen Turso-Konto anlegen und deren Verbindungs-URL übernehmen. Einen ausschließlich für diese Datenbank gültigen Token mit Daten- und Schemarechten erzeugen; Schemarechte werden für Migrationen benötigt. Den Plattform- oder Gruppentoken nicht verwenden.

Für Google einen API-Schlüssel im eigenen Google-AI-Konto erstellen und GOOGLE_GENERATIVE_AI_API_KEY setzen. Für Mistral einen Schlüssel im eigenen Mistral-Konto erstellen und MISTRAL_API_KEY setzen. Einer der beiden Anbieter reicht für Transkription; die separate Textverbesserung benötigt Mistral. Nicht konfigurierte Anbieter werden als nicht verfügbar ausgewiesen.

Für einen weiteren Rechner dieselbe Turso-Datenbank verwenden und die Zugangsdaten dort in einer eigenen .env.local hinterlegen. Keine zweite Datenbank anlegen, wenn die Notizen gemeinsam verfügbar sein sollen. Audiodateien und noch nicht synchronisierte Entwürfe bleiben auf dem jeweiligen Gerät.

### Lokaler Start

1. Abhängigkeiten mit `npm ci` installieren.
2. `.env.example` als `.env.local` kopieren und mit der eigenen Projektkonfiguration ausfüllen.
3. Schema mit `npm run db:migrate` anlegen oder aktualisieren.
4. Mit `npm run build` bauen und mit `npm start` starten.

Die Verfügbarkeit der Anbindungen lässt sich anschließend unter [localhost:3210/api/config](http://localhost:3210/api/config) prüfen; diese Antwort enthält keine Schlüsselwerte.

Für die Entwicklung: `npm run dev`. Der Launcher bindet ausschließlich `127.0.0.1:3210`; der Browser-Origin ist standardmäßig `http://localhost:3210`. Eine Änderung der Konfiguration benötigt einen Serverneustart. Geerbte Datenbank- und Modellschlüssel übersteuern die Produktdatei nicht. Zusätzliche Env-Dateien und unbekannte Schlüssel werden vor Start und Build abgewiesen. Ein Build funktioniert auch ohne Konfigurationsdatei und ohne Zugangsdaten.

Zugangsdaten gehören ausschließlich in die ignorierte `.env.local`. Keine Konfiguration eines anderen Projekts übernehmen. Zur Laufzeit genügt ein Token der eigenen Datenbank, kein Turso-Plattformtoken. API-Schlüssel werden niemals an den Browser zurückgegeben.

## Implementierter Serverteil

- Notizen mit unveränderlichem Ursprung, bearbeitbarer Fassung und Revisionsprüfung.
- Wiederholbares Erstellen ohne Überschreiben späterer Änderungen.
- Dauerhafte Löschmarker gegen verspätete Wiederanlage.
- Gemeinsames Vokabular mit Konflikterkennung.
- Google- und Mistral-Transkription mit getrennten Fähigkeiten.
- Optionale Textverbesserung als eigenständiger Vorschlag.
- Begrenzte Audioannahme, Zeitlimits und zwei parallele Modellanfragen pro Serverprozess.
- Einheitliche Fehlerantworten ohne Anbieterinhalte oder Zugangsdaten.

Die API ist für die lokale Anwendung bestimmt. Schreibaufrufe erfordern den konfigurierten Origin sowie `X-Voice-Workbench: 1`. Konkrete Routen, Felder und Fehlercodes stehen in `docs/design/voice-workbench.md`.

## Prüfungen

- `npm test`: deterministische Tests ohne Anbieter- oder Cloudaufrufe.
- `npm run typecheck`: TypeScript einschließlich Tests und Startskripten.
- `npm run lint`: Codeprüfung.
- `npm run format:check`: einheitliche Formatierung.
- `npm run build`: Produktionsbuild.

`npm run format` formatiert ausschließlich Quellcode, Skripte, Tests und Konfigurationen. Der Checkout verwendet auch auf Windows LF-Zeilenenden, damit die Migrationsprüfsummen gleich bleiben. Angewendete SQL-Migrationen werden nicht verändert; Änderungen erhalten eine neue Migrationsdatei. Der Runner prüft gespeicherte Checksummen und führt jede Datei transaktional aus.

## Datenfluss und Grenzen

Audio und Vokabular werden bei einem gestarteten Transkriptionsaufruf an den gewählten Anbieter übertragen. Die optionale Textverbesserung sendet Text an Mistral. Texte und Einstellungen liegen in Turso. Der geplante Browserteil hält Audio und noch nicht synchronisierte Entwürfe auf dem jeweiligen Gerät; Audio wird nicht zwischen Geräten synchronisiert.

Textverbesserung kann Bedeutung oder Reihenfolge verändern, auch bei ausdrücklichen Erhaltungsanweisungen. Sie liefert deshalb ausschließlich einen Vorschlag. Das Original bleibt erhalten; unvollständig beendete Modellantworten werden nicht angeboten.

Die Anwendung bietet keine Authentifizierung gegenüber anderen lokalen Prozessen. Sie ist nicht für öffentliche Netzwerkfreigabe eingerichtet. Der Datenbanktoken ist auf eine Datenbank beschränkt, besitzt innerhalb dieser Datenbank aber auch die für Migrationen verwendeten Schemarechte. Die zehn Minuten Aufnahmezeit sind eine geplante UI-Grenze; serverseitig gelten Byte- und Zeitgrenzen, keine nachgemessene Audiodauer.

## Lizenz

Derzeit ist keine Nutzungslizenz für den Anwendungscode vergeben.
