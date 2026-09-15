import "server-only";
import { createClient, type Client } from "@libsql/client";
import { createApi } from "./api";
import { getConfig, type RuntimeConfig } from "./config";
import { Store } from "./store";
import { createModels, type Models } from "./models";

type Resources = {
  db?: Client;
  config?: RuntimeConfig;
  slots: { active: number };
};
const processState = globalThis as typeof globalThis & {
  voiceWorkbenchResources?: Resources;
};
if (!processState.voiceWorkbenchResources) {
  const resources: Resources = { slots: { active: 0 } };
  processState.voiceWorkbenchResources = resources;
  process.once("exit", () => resources.db?.close());
}
// Ressourcen überleben HMR, Anwendungscode wird beim Modulwechsel neu geladen.
const resources = processState.voiceWorkbenchResources;
let handle: ReturnType<typeof createApi> | undefined;
export function application() {
  if (!handle) {
    const config = () => (resources.config ??= getConfig());
    let store: Store | undefined;
    let models: Models | undefined;
    handle = createApi({
      getConfig: config,
      getStore: () => {
        if (!store) {
          resources.db ??= createClient({
            url: config().databaseUrl,
            authToken: config().databaseToken,
          });
          store = new Store(resources.db);
        }
        return store;
      },
      getModels: () => (models ??= createModels(config())),
      modelSlots: resources.slots,
      log: (entry) => {
        if (entry.status >= 500) console.error(JSON.stringify(entry));
      },
    });
  }
  return handle;
}
