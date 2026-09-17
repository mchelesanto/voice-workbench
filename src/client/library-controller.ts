import {
  libraryStateSchema,
  resetReceiptSchema,
  resetResolutionSchema,
  type LibraryState,
  type ResetInput,
  type ResetReceipt,
  type ResetResolution,
} from "../shared/contracts";
import { ClientError, request } from "./api";
import {
  acknowledgeReset,
  authorizeLocal,
  completeReset,
  LocalStateError,
  prepareReset,
  readMetadata,
  reconcileLocal,
  releaseReset,
  type LocalMetadata,
  type PendingReset,
  type TabFence,
} from "./local-store";
import type { Draft } from "./editor";
export type LibrarySnapshot = {
  epoch: number;
  phase: "loading" | "ready" | "offline" | "pending" | "cleanup";
  generation: number | null;
  pending: PendingReset | null;
  legacyPending: boolean;
  error: string;
  repair?: ResetResolution;
};
export type LibraryPorts = {
  invalidate: (kind: "local" | "remote", fence: TabFence) => Draft[];
  pause: () => void;
  resume: () => void;
  preserved: (drafts: Draft[]) => void;
  busy: () => boolean;
};
export class LibraryController {
  private value: LibrarySnapshot = {
    epoch: 0,
    phase: "loading",
    generation: null,
    pending: null,
    legacyPending: false,
    error: "",
  };
  private listeners = new Set<() => void>();
  private fence?: TabFence;
  private epoch = 0;
  private historical: Draft[] = [];
  private syncing?: Promise<void>;
  private requests = new Set<AbortController>();
  private lifetime = new AbortController();
  private resetBusy = false;
  private paused = false;
  private channel?: BroadcastChannel;
  private stopEvents?: () => void;
  constructor(
    private ports: LibraryPorts = {
      invalidate: () => [],
      pause: () => {},
      resume: () => {},
      preserved: () => {},
      busy: () => true,
    },
  ) {}
  configure(ports: LibraryPorts) {
    this.ports = ports;
  }
  snapshot = () => this.value;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private publish(patch: Partial<LibrarySnapshot>) {
    this.value = { ...this.value, ...patch, epoch: this.epoch };
    this.listeners.forEach((fn) => fn());
  }
  private abortWork() {
    this.epoch++;
    for (const c of this.requests) c.abort();
    this.requests.clear();
  }
  private invalidate(kind: "local" | "remote", fence: TabFence) {
    this.abortWork();
    const snapshots = this.ports.invalidate(kind, fence);
    if (kind === "local") this.historical = [];
    else this.historical.push(...snapshots);
  }
  private pause() {
    if (this.paused) return;
    this.paused = true;
    this.abortWork();
    this.ports.pause();
  }
  private resume() {
    if (!this.paused) return;
    this.paused = false;
    this.ports.resume();
  }
  private broadcast() {
    this.channel?.postMessage({ changed: true });
  }
  start() {
    if (this.stopEvents) return;
    if (this.lifetime.signal.aborted) {
      this.lifetime = new AbortController();
      this.syncing = undefined;
    }
    const sync = () => {
      if (document.visibilityState === "visible") void this.sync();
    };
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel("voice-workbench-library");
      this.channel.onmessage = () => void this.sync();
    }
    window.addEventListener("pageshow", sync);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    const timer = setInterval(sync, 30000);
    this.stopEvents = () => {
      clearInterval(timer);
      window.removeEventListener("pageshow", sync);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
      this.channel?.close();
    };
    void this.sync();
  }
  dispose() {
    this.stopEvents?.();
    this.stopEvents = undefined;
    this.lifetime.abort();
    this.abortWork();
    this.listeners.clear();
  }
  sync(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve();
    if (!this.syncing) {
      const signal = this.lifetime.signal;
      const work = this.reconcile(signal)
        .catch((error) => {
          if (!signal.aborted)
            this.publish({
              phase: "offline",
              error:
                error instanceof Error
                  ? error.message
                  : "The library could not be checked.",
            });
        })
        .finally(() => {
          if (this.syncing === work) this.syncing = undefined;
        });
      this.syncing = work;
    }
    return this.syncing;
  }
  private observeMarker(metadata: LocalMetadata) {
    if (!this.fence)
      this.fence = {
        generation: metadata.observedGeneration,
        localResetId: metadata.completedLocalResetId,
      };
    else if (this.fence.localResetId !== metadata.completedLocalResetId) {
      this.invalidate("local", this.fence);
      this.fence = {
        generation: metadata.observedGeneration,
        localResetId: metadata.completedLocalResetId,
      };
    }
  }
  private async advanceKnown(metadata: LocalMetadata, signal: AbortSignal) {
    if (
      !metadata.initialized ||
      !this.fence ||
      metadata.observedGeneration <= this.fence.generation
    )
      return metadata;
    const previous = { ...this.fence };
    this.invalidate("remote", previous);
    const current = await reconcileLocal(
      metadata.observedGeneration,
      previous,
      this.historical,
    );
    if (signal.aborted) return current;
    this.observeMarker(current);
    if (current.completedLocalResetId === previous.localResetId) {
      this.ports.preserved(this.historical);
      this.historical = [];
    }
    this.fence = {
      generation: current.observedGeneration,
      localResetId: current.completedLocalResetId,
    };
    return current;
  }
  private async reconcile(signal: AbortSignal) {
    let metadata = await readMetadata();
    if (signal.aborted) return;
    this.observeMarker(metadata);
    if (metadata.pendingReset) {
      this.pause();
      this.publish({
        phase:
          metadata.pendingReset.phase === "acknowledged"
            ? "cleanup"
            : "pending",
        pending: metadata.pendingReset,
        generation: metadata.observedGeneration,
        legacyPending: metadata.legacyAudioTransition === "pending",
      });
      if (metadata.pendingReset.phase === "acknowledged" && !this.resetBusy) {
        this.invalidate("local", this.fence!);
        await completeReset(metadata.pendingReset);
        this.broadcast();
        metadata = await readMetadata();
        this.observeMarker(metadata);
        if (metadata.pendingReset) return;
      } else return;
    }
    metadata = await this.advanceKnown(metadata, signal);
    if (signal.aborted) return;
    let state: LibraryState;
    try {
      state = await request("/library-state", libraryStateSchema, {
        signal: signal,
      });
    } catch (error) {
      this.publish({
        phase: "offline",
        generation: metadata.initialized ? metadata.observedGeneration : null,
        pending: null,
        legacyPending: metadata.legacyAudioTransition === "pending",
        error: error instanceof Error ? error.message : "Library unavailable.",
      });
      return;
    }
    if (signal.aborted) return;
    const target = Math.max(
      state.generation,
      metadata.observedGeneration,
      this.fence!.generation,
    );
    const previous = { ...this.fence! };
    if (target > previous.generation) this.invalidate("remote", previous);
    try {
      metadata = await reconcileLocal(target, previous, this.historical);
    } catch (error) {
      if (error instanceof LocalStateError && error.code === "reset_pending") {
        this.pause();
        const current = await readMetadata();
        this.publish({ phase: "pending", pending: current.pendingReset });
        return;
      }
      throw error;
    }
    if (signal.aborted) return;
    this.observeMarker(metadata);
    if (metadata.completedLocalResetId === previous.localResetId) {
      this.ports.preserved(this.historical);
      this.historical = [];
    }
    this.fence = {
      generation: metadata.observedGeneration,
      localResetId: metadata.completedLocalResetId,
    };
    this.publish({
      phase: "ready",
      generation: metadata.observedGeneration,
      pending: null,
      legacyPending: metadata.legacyAudioTransition === "pending",
      error: "",
      repair: undefined,
    });
    this.resume();
  }
  async captureFence(cached = false): Promise<TabFence> {
    if (cached) {
      let metadata = await readMetadata();
      this.observeMarker(metadata);
      if (!metadata.initialized || metadata.pendingReset)
        throw new ClientError("Finish library setup or pending cleanup first.");
      metadata = await this.advanceKnown(metadata, this.lifetime.signal);
      this.publish({
        generation: metadata.observedGeneration,
        legacyPending: metadata.legacyAudioTransition === "pending",
      });
    } else {
      await this.sync();
      if (this.value.phase !== "ready")
        throw new ClientError(
          "The library is offline. You can choose to record with previously loaded words.",
        );
    }
    if (
      !this.fence ||
      this.value.generation === null ||
      this.value.pending ||
      this.value.legacyPending
    )
      throw new ClientError(
        this.value.legacyPending
          ? "Review earlier saved audio before starting a new recording."
          : "Finish library setup or pending cleanup first.",
      );
    await authorizeLocal(this.fence);
    return { ...this.fence };
  }
  async localAccess() {
    const epoch = this.epoch;
    const fence = this.fence;
    const metadata = await readMetadata();
    if (
      !fence ||
      metadata.completedLocalResetId !== fence.localResetId ||
      epoch !== this.epoch
    ) {
      await this.sync();
      throw new ClientError(
        "The local library changed. Open the current copy again.",
      );
    }
  }
  async audioAccess(fence: TabFence) {
    const metadata = await readMetadata();
    if (metadata.completedLocalResetId !== fence.localResetId) {
      await this.sync();
      throw new ClientError("This browser profile was cleared.");
    }
    // Audio from an older remote generation remains exportable.
    this.observeMarker(metadata);
  }
  async execute<T>(
    generation: number,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    await this.sync();
    if (!this.fence || generation !== this.fence.generation)
      throw new ClientError(
        "This content cannot be changed in the current library.",
        409,
        "library_reset",
      );
    if (this.value.phase !== "ready")
      throw new ClientError(
        "The library is offline or cleanup is pending. Your content remains available.",
        503,
        "storage_unavailable",
      );
    const fence = { ...this.fence },
      epoch = this.epoch;
    await authorizeLocal(fence);
    const controller = new AbortController();
    this.requests.add(controller);
    try {
      const value = await run(controller.signal);
      if (
        typeof value === "object" &&
        value !== null &&
        "generation" in value &&
        value.generation !== generation
      )
        throw new ClientError(
          "This response belongs to another library.",
          409,
          "library_reset",
        );
      await this.sync();
      await authorizeLocal(fence);
      if (epoch !== this.epoch || this.lifetime.signal.aborted)
        throw new ClientError(
          "This operation belongs to an earlier library.",
          409,
          "library_reset",
        );
      return value;
    } catch (error) {
      if (
        (error instanceof ClientError && error.code === "library_reset") ||
        error instanceof LocalStateError
      )
        await this.sync();
      throw error;
    } finally {
      this.requests.delete(controller);
    }
  }
  async beginReset(confirmation: string) {
    if (confirmation !== "DELETE ALL NOTES")
      throw new ClientError("Type DELETE ALL NOTES to confirm.");
    if (this.resetBusy || this.ports.busy())
      throw new ClientError("Finish or cancel the current operation first.");
    this.resetBusy = true;
    try {
      await this.sync();
      if (!this.fence || this.value.phase !== "ready")
        throw new ClientError("Check the library connection first.");
      const operationId = crypto.randomUUID();
      const pending = await prepareReset(operationId, this.fence.generation);
      this.pause();
      this.publish({ phase: "pending", pending });
      this.broadcast();
      if (pending.operationId === operationId) await this.sendReset(pending);
    } finally {
      this.resetBusy = false;
      await this.sync();
    }
  }
  private async applyReceipt(expected: ResetInput, receipt: ResetReceipt) {
    if (!(await acknowledgeReset(expected, receipt))) {
      return;
    }
    if (this.fence) this.invalidate("local", this.fence);
    this.publish({ phase: "cleanup" });
    await completeReset(expected);
    this.broadcast();
  }
  private async outcomeFailure(error: unknown, expected: ResetInput) {
    if (error instanceof ClientError && error.conflict?.kind === "reset") {
      if (error.code === "reset_cancelled") {
        await releaseReset(expected, error.conflict.current);
        this.broadcast();
        return;
      }
      if (error.code === "reset_conflict") {
        this.publish({ repair: error.conflict.current, error: error.message });
        return;
      }
    }
    this.publish({
      error:
        error instanceof Error
          ? error.message
          : "The reset outcome is unknown. Retry or resolve the same operation.",
    });
  }
  private async sendReset(pending: PendingReset) {
    if (pending.phase === "acknowledged") {
      await this.applyReceipt(pending, pending.receipt);
      return;
    }
    try {
      const receipt = await request("/library/reset", resetReceiptSchema, {
        method: "POST",
        operation: "reset",
        body: {
          operationId: pending.operationId,
          expectedGeneration: pending.expectedGeneration,
          confirmation: "DELETE ALL NOTES",
        },
        signal: this.lifetime.signal,
      });
      await this.applyReceipt(pending, receipt);
    } catch (error) {
      await this.outcomeFailure(error, pending);
    }
  }
  async retryReset() {
    if (this.resetBusy) return;
    this.resetBusy = true;
    try {
      const pending = (await readMetadata()).pendingReset;
      if (pending) await this.sendReset(pending);
    } finally {
      this.resetBusy = false;
      await this.sync();
    }
  }
  async cancelReset() {
    if (this.resetBusy) return;
    this.resetBusy = true;
    try {
      const pending = (await readMetadata()).pendingReset;
      if (!pending) return;
      if (pending.phase === "acknowledged") {
        await this.applyReceipt(pending, pending.receipt);
        return;
      }
      try {
        const resolution = await request(
          "/library/reset/cancel",
          resetResolutionSchema,
          {
            method: "POST",
            operation: "reset",
            body: {
              operationId: pending.operationId,
              expectedGeneration: pending.expectedGeneration,
            },
            signal: this.lifetime.signal,
          },
        );
        if (resolution.state === "completed")
          await this.applyReceipt(pending, resolution.receipt);
        else {
          await releaseReset(pending, resolution);
          this.broadcast();
        }
      } catch (error) {
        await this.outcomeFailure(error, pending);
      }
    } finally {
      this.resetBusy = false;
      await this.sync();
    }
  }
  async releaseConflictingClaim() {
    if (this.resetBusy || !this.value.repair) return;
    this.resetBusy = true;
    try {
      const pending = (await readMetadata()).pendingReset;
      if (pending) await releaseReset(pending, this.value.repair, true);
      this.broadcast();
    } finally {
      this.resetBusy = false;
      await this.sync();
    }
  }
}
