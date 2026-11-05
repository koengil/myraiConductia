// The corpus lives in scripts/lib/screeningCorpus.ts, which scripts/screening-eval.ts reads: production code
// never imports from tests/ (tests/mailbox-reader-fence.test.ts). Re-exported so the tests import it from here.
export * from '../../../scripts/lib/screeningCorpus';
