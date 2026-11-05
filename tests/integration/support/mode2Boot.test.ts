import { describe, expect, it, vi } from "vitest";
import { bootMode2 } from "./mode2Boot";

class FakeServer {
  stopped = false;
  async stop(): Promise<void> {
    this.stopped = true;
  }
}

async function stopsTheServerWhenFixtureBuildingThrows(): Promise<void> {
  const server = new FakeServer();
  const startServer = async (): Promise<FakeServer> => server;
  const buildFixtures = async (): Promise<never> => {
    throw new Error("mode 2 fixture build failed");
  };

  await expect(bootMode2(startServer, () => {}, buildFixtures)).rejects.toThrow(
    "mode 2 fixture build failed",
  );

  expect(server.stopped).toBe(true);
}

class ThrowingStopServer {
  async stop(): Promise<void> {
    throw new Error("stop failed");
  }
}

async function surfacesTheFixtureErrorEvenWhenStopThrows(): Promise<void> {
  const server = new ThrowingStopServer();
  const startServer = async (): Promise<ThrowingStopServer> => server;
  const buildFixtures = async (): Promise<never> => {
    throw new Error("mode 2 fixture build failed");
  };
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);

  await expect(bootMode2(startServer, () => {}, buildFixtures)).rejects.toThrow(
    "mode 2 fixture build failed",
  );

  errorSpy.mockRestore();
}

async function returnsTheServerAndContextOnSuccess(): Promise<void> {
  const server = new FakeServer();
  const startServer = async (): Promise<FakeServer> => server;
  const buildFixtures = async (): Promise<{ value: string }> => ({
    value: "ok",
  });

  const booted = await bootMode2(startServer, () => {}, buildFixtures);

  expect(booted.server).toBe(server);
  expect(booted.context).toEqual({ value: "ok" });
  expect(server.stopped).toBe(false);
}

describe("mode 2 boot sequence", () => {
  it(
    "stops the server when fixture building throws",
    stopsTheServerWhenFixtureBuildingThrows,
  );
  it(
    "returns the server and context on success",
    returnsTheServerAndContextOnSuccess,
  );
  it(
    "surfaces the fixture error even when stop throws",
    surfacesTheFixtureErrorEvenWhenStopThrows,
  );
});
