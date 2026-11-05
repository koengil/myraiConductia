// Only prose at these known documentation locations is eligible. In particular,
// fixtures, skill packages, design assets and nested research data run full CI.
// Shared by CI's docs-only detector and the Vercel ignored build step.
export function isDocumentation(file) {
  return file === 'README.md' || file === 'docs/README.md' ||
    /^docs\/(00-vision|01-business|02-product|03-engineering|04-operations|04-brand|05-growth|06-research|07-decisions)\/[^/\r\n]+\.md$/.test(file);
}
