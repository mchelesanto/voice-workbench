import { describe, it, expect } from "vitest";
import { canonicalOrigin } from "../src/server/canonical-origin";

const origin = "http://localhost:3210";

describe("Canonical page origin", () => {
  it("redirects the loopback address to the configured origin", () => {
    expect(canonicalOrigin("127.0.0.1:3210", origin)).toBe(
      "http://localhost:3210/",
    );
  });

  it("leaves the configured host untouched", () => {
    expect(canonicalOrigin("localhost:3210", origin)).toBeNull();
  });

  it("follows the configured origin in either direction", () => {
    expect(canonicalOrigin("localhost:3210", "http://127.0.0.1:3210")).toBe(
      "http://127.0.0.1:3210/",
    );
  });

  it.each(["attacker.test", "localhost:3211", null])(
    "never derives the target from the request host (%s)",
    (host) => {
      expect(canonicalOrigin(host, origin)).toBe("http://localhost:3210/");
    },
  );

  it.each([undefined, "", "not a url"])(
    "passes through when the origin is not configured (%s)",
    (configured) => {
      expect(canonicalOrigin("127.0.0.1:3210", configured)).toBeNull();
    },
  );
});
