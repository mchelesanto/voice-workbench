import "server-only";
import { createApi } from "./api";
import { getConfig, type RuntimeConfig } from "./config";
import { createRemoteStore } from "./storage-operation";
import { createModels, type Models } from "./models";

type Resources = {
  config?: RuntimeConfig;
  slots: { active: number };
};
const processState = globalThis as typeof globalThis & {
  voiceWorkbenchResources?: Resources;
};
if (!processState.voiceWorkbenchResources) {
  const resources: Resources = { slots: { active: 0 } };
  processState.voiceWorkbenchResources = resources;
}
// Resources survive HMR; application code is reloaded with each module update.
const resources = processState.voiceWorkbenchResources;
let handle: ReturnType<typeof createApi> | undefined;
export function application() {
  if (!handle) {
    const config = () => (resources.config ??= getConfig());
    let models: Models | undefined;
    handle = createApi({
      getConfig: config,
      getStore: (signal) => createRemoteStore(config(), signal),
      getModels: () => (models ??= createModels(config())),
      modelSlots: resources.slots,
      log: (entry) => {
        if (entry.status >= 500) console.error(JSON.stringify(entry));
      },
    });
  }
  return handle;
}
