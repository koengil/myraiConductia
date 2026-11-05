// The rule detector (#173 G-07 slice 3a): pure, deterministic, no model and no output. The fence test
// (tests/discovery-detect-fence.test.ts) covers every file in this directory.
export {
  cutWrappedQuoteOpener,
  detectMilestones,
  RULES_V1,
  RULES_VERSION,
  type DetectedEvent,
  type MilestoneRule,
} from './rules.v1';
