import { beforeEach, expect, it, vi } from "vitest";
import { LibraryController } from "../src/client/library-controller";
import {
  authorizeLocal,
  readMetadata,
  reconcileLocal,
  type LocalMetadata,
} from "../src/client/local-store";
import { request } from "../src/client/api";

vi.mock("../src/client/local-store", async (original) => ({
  ...(await original<typeof import("../src/client/local-store")>()),
  readMetadata: vi.fn(),
  reconcileLocal: vi.fn(),
  authorizeLocal: vi.fn(),
}));
vi.mock("../src/client/api", async (original) => ({
  ...(await original<typeof import("../src/client/api")>()),
  request: vi.fn(),
}));
let metadata: LocalMetadata;
beforeEach(() => {
  vi.clearAllMocks();
  metadata = {
    profileId: "11111111-1111-4111-8111-111111111111",
    observedGeneration: 1,
    initialized: true,
    pendingReset: null,
    completedLocalResetId: null,
    legacyAudioTransition: "pending",
  };
  vi.mocked(readMetadata).mockResolvedValue(metadata);
  vi.mocked(reconcileLocal).mockResolvedValue(metadata);
  vi.mocked(authorizeLocal).mockResolvedValue(metadata);
  vi.mocked(request).mockResolvedValue({ generation: 1, lastResetAt: null });
});
it.each([false, true])(
  "allows capture with retained legacy audio (cached context: %s)",
  async (cached) => {
    const controller = new LibraryController();
    await expect(controller.captureFence(cached)).resolves.toEqual({
      generation: 1,
      localResetId: null,
    });
    expect(authorizeLocal).toHaveBeenCalledWith({
      generation: 1,
      localResetId: null,
    });
    expect(metadata.legacyAudioTransition).toBe("pending");
    controller.dispose();
  },
);
it.each([false, true])(
  "still blocks capture during an actual reset (cached context: %s)",
  async (cached) => {
    metadata.pendingReset = {
      operationId: "22222222-2222-4222-8222-222222222222",
      expectedGeneration: 1,
      phase: "prepared",
    };
    const controller = new LibraryController();
    await expect(controller.captureFence(cached)).rejects.toThrow();
    expect(authorizeLocal).not.toHaveBeenCalled();
    controller.dispose();
  },
);
