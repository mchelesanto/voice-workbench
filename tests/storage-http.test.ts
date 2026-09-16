import { expect, it } from "vitest";
import { createServer } from "node:http";
import {
  createRemoteStore,
  withStorageOperation,
} from "../src/server/storage-operation";

it("aborts a real loopback HTTP response while LibSQL is reading its stalled body", async () => {
  let observed!: () => void;
  const received = new Promise<void>((resolve) => {
    observed = resolve;
  });
  let disconnected!: () => void;
  const closed = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"baton":');
    response.on("close", disconnected);
    observed();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test port");
    const config = {
      origin: "http://localhost:3210",
      databaseUrl: `http://127.0.0.1:${address.port}`,
      databaseToken: "synthetic-fixture",
      googleKey: "",
      mistralKey: "",
      fireworksKey: "",
    };
    const controller = new AbortController();
    const work = withStorageOperation(
      controller.signal,
      (signal) => createRemoteStore(config, signal),
      (store) => store.settings(),
    ).catch((error) => error);
    await received;
    controller.abort();
    expect(await work).toMatchObject({ code: "request_aborted" });
    await closed;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
