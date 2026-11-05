// @ts-check
/**
 * The shell side of the #162 stack identity (localStack.mjs is the source):
 *
 *   node scripts/perf/stack-identity.mjs ports
 *     prints "<project id> <API port> <DB port>" (rail-stack.sh reads it)
 *
 *   docker ps --format '{{.Names}}\t{{.Ports}}' | node scripts/perf/stack-identity.mjs running
 *     exits 1 with `assertLocalStack: refused stack …` unless the expected
 *     ports are published by this stack's own containers
 *     (with-local-stack.sh --write runs it before any write)
 */
import fs from 'node:fs';

import {
  PERF_STACK_API_PORT,
  PERF_STACK_DB_PORT,
  PERF_STACK_PROJECT_ID,
  assertRunningStack,
} from './localStack.mjs';

const command = process.argv[2];
if (command === 'ports') {
  process.stdout.write(`${PERF_STACK_PROJECT_ID} ${PERF_STACK_API_PORT} ${PERF_STACK_DB_PORT}\n`);
} else if (command === 'running') {
  try {
    const stack = assertRunningStack(fs.readFileSync(0, 'utf8'));
    process.stderr.write(
      `assertLocalStack: running project_id=${stack.projectId} api=${stack.apiPort} db=${stack.dbPort}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
} else {
  process.stderr.write('usage: stack-identity.mjs ports | running (docker ps output on stdin)\n');
  process.exit(2);
}
