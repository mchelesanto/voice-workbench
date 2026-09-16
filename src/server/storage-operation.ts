import "server-only";
import { createClient } from "@libsql/client";
import type { RuntimeConfig } from "./config";
import { ApiError } from "./errors";
import { untilAborted } from "./model-slots";
import { Store } from "./store";

export const STORAGE_DEADLINE_MS = 12000;

export function createRemoteStore(config: RuntimeConfig, signal: AbortSignal) {
  const db = createClient({
    url: config.databaseUrl,
    authToken: config.databaseToken,
    fetch: (request: Request) => {
      signal.throwIfAborted();
      return fetch(request, {
        signal: AbortSignal.any([signal, request.signal]),
      });
    },
  });
  return new Store(db, () => db.close());
}

// The operation and every transport request share one deadline. A canceled
// write may have committed remotely; callers retain their replay identity.
export async function withStorageOperation<T>(
  requestSignal: AbortSignal,
  getStore: (signal: AbortSignal) => Store,
  run: (store: Store) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new ApiError("request_aborted"));
  requestSignal.addEventListener("abort", cancel, { once: true });
  if (requestSignal.aborted) cancel();
  const timer = setTimeout(
    () => controller.abort(new ApiError("storage_timeout")),
    STORAGE_DEADLINE_MS,
  );
  let store: Store | undefined;
  let released = false;
  const release = () => {
    if (released || !store) return;
    released = true;
    try {
      store?.dispose();
    } catch {
      /* Cleanup cannot change a confirmed outcome. */
    }
  };
  controller.signal.addEventListener("abort", release, { once: true });
  try {
    controller.signal.throwIfAborted();
    store = getStore(controller.signal);
    const work = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return run(store!);
    });
    return await untilAborted(work, controller.signal);
  } finally {
    clearTimeout(timer);
    requestSignal.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", release);
    release();
  }
}
