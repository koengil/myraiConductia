// @ts-check
/**
 * Preload for every node child of scripts/perf/with-local-stack.sh:
 *
 *   NODE_OPTIONS="--import <repo>/scripts/perf/assert-local-stack.mjs"
 *
 * It checks the process's OWN effective environment before any of the
 * process's code runs, so a variable injected after the wrapper (for example
 * `env DATABASE_URL=… node …`) is still caught. On refusal it prints the
 * reason (variable name and host, never a credential) and exits 1.
 */
import { assertLocalStack } from './localStack.mjs';

try {
  const check = assertLocalStack(process.env);
  if (process.env.PERF_ASSERT_VERBOSE === '1') {
    const targets = Object.entries(check.targets)
      .map(([name, target]) => `${name}=${target}`)
      .join(' ');
    process.stderr.write(`assertLocalStack: ok project_id=${check.projectId} ${targets}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
