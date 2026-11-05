/**
 * A refusal the recorder raises itself. Its message is fixed text, never built from the config, a response or a
 * path the operator typed, so the CLI may print it as it is (record-graph.ts, describeFailure). Any other error
 * is printed by class only: its message may carry a request id or an address.
 */
export class RecorderRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecorderRefusal';
  }
}
