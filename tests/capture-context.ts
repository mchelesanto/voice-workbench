import type { CaptureContext } from "../src/client/recording";
export function captureContext(
  overrides: Partial<CaptureContext> = {},
): CaptureContext {
  return {
    id: crypto.randomUUID(),
    generation: 1,
    areaId: null,
    areaLabel: "General",
    vocabulary: [],
    createdAt: "2026-09-17T00:00:00.000Z",
    localResetId: null,
    ...overrides,
  };
}
