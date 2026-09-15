import "server-only";
import { ApiError } from "./errors";
export interface ModelLease {
  retainUntil(work: Promise<unknown>): void;
}
export async function withModelSlot<T>(
  slots: { active: number },
  run: (lease: ModelLease) => Promise<T>,
): Promise<T> {
  if (slots.active >= 2) throw new ApiError("busy");
  slots.active++;
  let retained: Promise<unknown> | undefined;
  try {
    return await run({
      retainUntil(work) {
        // Ein Slot gehört zu genau einem SDK-Vorgang.
        if (retained) throw new Error("Model lease already retained");
        retained = work.then(
          () => undefined,
          () => undefined,
        );
      },
    });
  } finally {
    if (retained)
      void retained.then(() => {
        slots.active--;
      });
    else slots.active--;
  }
}
export function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const clean = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      clean();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    // Auch verspätete Ablehnungen werden konsumiert.
    work.then(
      (value) => {
        clean();
        resolve(value);
      },
      (error) => {
        clean();
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}
