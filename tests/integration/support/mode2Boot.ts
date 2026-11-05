export type StoppableServer = { stop(): Promise<void> };

export type Mode2Boot<TServer, TContext> = {
  server: TServer;
  context: TContext;
};

export async function bootMode2<TServer extends StoppableServer, TContext>(
  startServer: () => Promise<TServer>,
  afterStart: (server: TServer) => void,
  buildFixtures: () => Promise<TContext>,
): Promise<Mode2Boot<TServer, TContext>> {
  const server = await startServer();
  try {
    afterStart(server);
    const context = await buildFixtures();
    return { server, context };
  } catch (error) {
    try {
      await server.stop();
    } catch (stopError) {
      console.error("mode2_boot_stop_failed_during_fixture_error", stopError);
    }
    throw error;
  }
}
