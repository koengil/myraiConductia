// Pure planning for the wake function (wake.mjs): no AWS or GitHub call here,
// so `node --test infra/ci-runner/lambda/` exercises it offline.

// Sorts EC2 instances into heavy-capable and light capacity. An instance counts
// as idle when pending/running and its runner (`<instance-id>-<class>`) is not
// busy. Stopped ids are listed in start order: within a kind, classes in
// `burstClasses` come last, so burst runners start only once the base ones are
// all up or busy.
export function classify(instances, busy, heavyClasses, burstClasses) {
  const f = {
    heavy: { idle: 0, stopped: [] },
    light: { idle: 0, stopped: [] },
  };
  const later = { heavy: [], light: [] };
  for (const i of instances) {
    const cls = i.Tags?.find((t) => t.Key === "RunnerClass")?.Value;
    const kind = heavyClasses.has(cls) ? "heavy" : "light";
    const state = i.State.Name;
    if (state === "stopped")
      (burstClasses.has(cls) ? later[kind] : f[kind].stopped).push(
        i.InstanceId,
      );
    else if (state !== "stopping" && !busy.has(`${i.InstanceId}-${cls}`))
      f[kind].idle += 1;
  }
  f.heavy.stopped.push(...later.heavy);
  f.light.stopped.push(...later.light);
  return f;
}

// How many of each kind to start. Heavy jobs take heavy-capable capacity; light
// jobs take light first, then spare heavy-capable capacity. Callers start the
// first n ids of each kind's stopped list (base classes before burst).
export function plan(q, f) {
  const startHeavy = Math.min(
    Math.max(0, q.heavy - f.heavy.idle),
    f.heavy.stopped.length,
  );
  const spareHeavy = Math.max(0, f.heavy.idle + startHeavy - q.heavy);
  const needLight = Math.max(0, q.light - f.light.idle - spareHeavy);
  const startLight = Math.min(needLight, f.light.stopped.length);
  const extraHeavy = Math.min(
    needLight - startLight,
    f.heavy.stopped.length - startHeavy,
  );
  return { heavy: startHeavy + extraHeavy, light: startLight };
}

// The instance ids to start for a plan.
export function toStart(f, n) {
  return [
    ...f.heavy.stopped.slice(0, n.heavy),
    ...f.light.stopped.slice(0, n.light),
  ];
}
