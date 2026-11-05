// node --test infra/ci-runner/lambda/  (not shipped in the Lambda zip)
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, plan, toStart } from "./plan.mjs";

const heavyClasses = new Set(["heavy", "burst"]);
const burstClasses = new Set(["burst"]);
const inst = (id, cls, state = "stopped") => ({
  InstanceId: id,
  State: { Name: state },
  Tags: [{ Key: "RunnerClass", Value: cls }],
});
// Burst listed first on purpose: the order must not come from EC2's order.
const fleet = [
  inst("b1", "burst"),
  inst("b2", "burst"),
  inst("h1", "heavy"),
  inst("h2", "heavy"),
  inst("l1", "light"),
  inst("l2", "light"),
];
const start = (q, instances, busy = new Set()) => {
  const f = classify(instances, busy, heavyClasses, burstClasses);
  return toStart(f, plan(q, f));
};

test("heavy jobs start heavy before burst", () => {
  assert.deepEqual(start({ heavy: 2, light: 0 }, fleet), ["h1", "h2"]);
  assert.deepEqual(start({ heavy: 3, light: 0 }, fleet), ["h1", "h2", "b1"]);
});

test("burst starts once heavy runners are busy", () => {
  const busy = new Set(["h1-heavy", "h2-heavy"]);
  const f = [
    inst("h1", "heavy", "running"),
    inst("h2", "heavy", "running"),
    ...fleet.slice(0, 2),
  ];
  assert.deepEqual(start({ heavy: 1, light: 0 }, f, busy), ["b1"]);
});

test("light jobs: light, then heavy, then burst", () => {
  assert.deepEqual(start({ heavy: 0, light: 2 }, fleet), ["l1", "l2"]);
  assert.deepEqual(start({ heavy: 0, light: 5 }, fleet), [
    "h1",
    "h2",
    "b1",
    "l1",
    "l2",
  ]);
});

test("an idle burst runner counts as heavy-capable capacity", () => {
  const f = [inst("b1", "burst", "running"), ...fleet.slice(2)];
  assert.deepEqual(start({ heavy: 1, light: 0 }, f), []);
});
