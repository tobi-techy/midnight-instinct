import { describe, expect, it, vi } from "vitest";
import { driveTunnel } from "../src/tunnel.js";

/** Let a rejected promise's `.catch` handler run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("driveTunnel", () => {
  it("drives the listener runtime exactly once", async () => {
    const serveForever = vi.fn(async () => undefined);
    driveTunnel({ serveForever });
    await settle();
    expect(serveForever).toHaveBeenCalledTimes(1);
  });

  it("does not reject the host when the runtime fails permanently", async () => {
    const serveForever = vi.fn(async () => {
      throw new Error("secret rotated");
    });
    expect(() => driveTunnel({ serveForever })).not.toThrow();
    await settle();
    expect(serveForever).toHaveBeenCalledTimes(1);
  });

  it("reports a fatal runtime error to the caller", async () => {
    const serveForever = vi.fn(async () => {
      throw new Error("secret rotated");
    });
    const onError = vi.fn();
    driveTunnel({ serveForever }, onError);
    await settle();
    expect(onError).toHaveBeenCalledWith("secret rotated");
  });

  it("reports a non-Error rejection without throwing", async () => {
    const serveForever = vi.fn(async () => {
      throw "socket closed";
    });
    const onError = vi.fn();
    driveTunnel({ serveForever }, onError);
    await settle();
    expect(onError).toHaveBeenCalledWith("socket closed");
  });
});
