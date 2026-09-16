# ADR 0002: GLM 5.3 Flash für Textverbesserung

Status: angenommen.

## Kontext und Entscheidung

Die Textverbesserung soll GLM 5.3 Flash über Fireworks verwenden. Transkription mit Google/Mistral, gespeicherte Notizursprünge und Audio-Recovery bleiben unabhängig. Ein optionaler `FIREWORKS_API_KEY` in der eigenen `.env.local` aktiviert Refine; Mistral allein aktiviert es nicht mehr.

Modell `accounts/fireworks/models/glm-5p3-flash` am festen Endpunkt `https://api.fireworks.ai/inference/v1/chat/completions`. Native Fetch-Anbindung statt zusätzlicher SDK-Dependency für einen einzigen Textaufruf. Preis dieser Entscheidung ist ein kleiner eigener Wire-Adapter samt Parser- und Fehlertests. Keine frei konfigurierbaren Hosts, keine Redirects, Tools, Modellfallbacks oder automatischen Retries.

Das Modell verlangt Thinking. Eine reale Probe wies `reasoning_effort=none` ab und bestätigte `low`. Daher `low`, gemeinsames Budget von 8192 Ausgabetokens einschließlich Thinking, bestehendes Limit von 12000 UTF-16-Einheiten und 120 Sekunden Gesamtfrist. Lange interne Überlegungen können das Budget ausschöpfen; unvollständige Antworten werden abgelehnt. Nur der finale `message.content` wird als Vorschlag angeboten, nie `reasoning_content`. Antwortstream mit dem bereits installierten SDK-Reader auf 2 MiB begrenzt, mit Content-Length-Frühprüfung und abgewarteter Cancellation. Fehlerausgaben enthalten keine Providerdetails.

Die bestehende Vorschau mit ausdrücklicher Übernahme schützt die Arbeitsfassung vor ungeprüften Änderungen. Ein Modellwechsel ist keine semantische Qualitätsgarantie. Refine-Ergebnisse identifizieren Fireworks als Provider; Notizursprünge verwenden weiterhin ausschließlich die Transkriptionsprovider. Frühere lokale Rücknahmefassungen enthalten nur Texte und bleiben lesbar, keine Speichermigration.

## Referenzfälle und Privilegien

R1 (mehrsprachiges Briefing): gleiche Erhaltungsanweisungen für Namen, Negationen und Reihenfolge, drei getrennte Stilvorgaben. R2 (Rechnerwechsel): jede Installation braucht den eigenen Fireworks-Konfigurationseintrag, Notizdaten bleiben kompatibel. R3 (Fehler): bisherige lokale Sicherung, manuelle Wiederholung und Abbruch gelten weiter. R4 (parallele Edits): Vorschlag bleibt an den Eingabesnapshot gebunden. R5 (fehlender Provider): verständlicher Setuphinweis für Fireworks, Aufnahmeprovider weiterhin verfügbar.

Nur Text des ausdrücklich angeforderten Refine-Vorgangs wird an Fireworks gesendet. Schlüssel bleibt serverseitig; Ausgabe an Browser nur Verfügbarkeit und deklarierte Modellkennung. Der Launcher ersetzt geerbte Werte und leert Fireworks-Konfiguration auch beim Build. Keine zusätzlichen Berechtigungen auf Turso oder auf Audio.

## Prior Art und Alternativen

- [Modellseite](https://app.fireworks.ai/models/fireworks/glm-5p3-flash): dokumentierte Modellkennung und Serverless-Chat-Completions-Anbindung.
- [Fireworks Chat Completions](https://docs.fireworks.ai/api-reference/post-chatcompletions): Bearer-Authentifizierung, max_tokens, separate finale und Reasoning-Ausgabe, Finish-Gründe.
- Bestehender Mistral-Adapter: einfacher weiterzubetreiben, erfüllt die gewählte Providerumstellung nicht.
- Zusätzlicher OpenAI-kompatibler SDK-Adapter: sinnvoll bei mehreren weiteren Providern oder Streaming; derzeit mehr Dependency-Umfang als benötigt.

## Revisionsauslöser

Wiederholte unvollständige Antworten, unzureichende semantische Treue oder unpassende Latenz im Alltag verlangen eine erneute Modell-/Budgetprüfung. Mehrere Textprovider oder Streaming rechtfertigen eine erneute SDK-Entscheidung. Kein stiller Fallback auf einen anderen Anbieter.
