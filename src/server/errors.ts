import "server-only";
import type { ErrorCode, FieldIssue } from "../shared/responses";
export type { ErrorCode } from "../shared/responses";
const definitions = {
  forbidden_origin: [403, "Dieser Zugriff ist nicht erlaubt."],
  method_not_allowed: [405, "Diese Methode ist hier nicht verfügbar."],
  api_not_found: [404, "Dieser Endpunkt existiert nicht."],
  unsupported_content_type: [415, "Dieses Datenformat wird nicht unterstützt."],
  invalid_input: [400, "Bitte prüfe die übergebenen Werte."],
  request_too_fragmented: [
    413,
    "Die Übertragung enthält zu viele Einzelstücke. Bitte versuche es erneut.",
  ],
  request_too_large: [413, "Die Anfrage ist zu groß."],
  audio_too_large: [
    413,
    "Die Aufnahme ist größer als 25 MiB. Sie bleibt auf diesem Gerät verfügbar.",
  ],
  request_timeout: [
    408,
    "Die Übertragung wurde nicht rechtzeitig abgeschlossen.",
  ],
  request_aborted: [408, "Die Übertragung wurde abgebrochen."],
  unsupported_audio: [
    415,
    "Das Audioformat wurde nicht erkannt oder passt nicht zur Datei.",
  ],
  unsupported_mode: [
    400,
    "Der gewählte Anbieter unterstützt diesen Modus nicht.",
  ],
  provider_unavailable: [
    503,
    "Für diesen Anbieter fehlt die lokale Konfiguration.",
  ],
  provider_auth_failed: [
    502,
    "Der Anbieter hat den Zugang abgelehnt. Bitte prüfe den API-Schlüssel.",
  ],
  provider_rate_limited: [
    429,
    "Der Anbieter nimmt gerade keine weitere Anfrage an. Bitte versuche es später erneut.",
  ],
  busy: [
    429,
    "Es werden bereits zwei Modellanfragen verarbeitet. Bitte warte kurz.",
  ],
  provider_timeout: [
    504,
    "Die Verarbeitung hat zu lange gedauert. Ein neuer Versuch kann erneut berechnet werden.",
  ],
  no_transcript: [
    422,
    "Es wurde kein verwendbares Transkript erzeugt. Deine Aufnahme bleibt erhalten.",
  ],
  transcription_failed: [
    502,
    "Die Transkription ist fehlgeschlagen. Deine Aufnahme bleibt erhalten.",
  ],
  enhancement_failed: [502, "Der Text konnte nicht überarbeitet werden."],
  enhancement_incomplete: [
    502,
    "Die Überarbeitung wurde nicht vollständig abgeschlossen. Dein Text bleibt unverändert.",
  ],
  enhancement_input_too_long: [
    400,
    "Die Textverbesserung unterstützt bis zu 12.000 Zeichen. Speichern und Export bleiben möglich.",
  ],
  output_too_large: [
    502,
    "Die Modellantwort überschreitet die unterstützte Textlänge.",
  ],
  storage_unavailable: [
    503,
    "Die Datenbank ist gerade nicht erreichbar. Dein lokaler Entwurf bleibt erhalten.",
  ],
  schema_unavailable: [
    503,
    "Die Datenbank muss mit npm run db:migrate vorbereitet werden.",
  ],
  configuration_unavailable: [
    503,
    "Die lokale Projektkonfiguration fehlt oder ist ungültig.",
  ],
  note_not_found: [404, "Die Notiz wurde nicht gefunden."],
  note_deleted: [
    410,
    "Diese Notiz wurde gelöscht. Du kannst deinen Entwurf als neue Notiz sichern.",
  ],
  id_conflict: [
    409,
    "Diese Notizkennung gehört bereits zu einer anderen Aufnahme.",
  ],
  revision_conflict: [
    409,
    "Die Notiz oder Einstellung wurde inzwischen geändert. Beide Fassungen bleiben verfügbar.",
  ],
  internal_error: [500, "Die Anfrage konnte nicht verarbeitet werden."],
} as const satisfies Record<ErrorCode, readonly [number, string]>;
export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    readonly current?: unknown,
    readonly issues?: FieldIssue[],
  ) {
    super(definitions[code][1]);
    this.name = "ApiError";
    this.status = definitions[code][0];
  }
}
