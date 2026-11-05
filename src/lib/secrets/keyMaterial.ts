/** Refuses any configuration that holds key material. A registration or
 * credential file names where a signer lives; it never holds a key (ADR-005's
 * rule, #259 R16). Pure and SDK-free, so scripts and the reader share it. */
export function keyMaterialProblems(raw: unknown): string[] {
  const text = JSON.stringify(raw ?? {});
  const problems: string[] = [];
  if (text.includes('-----BEGIN')) problems.push('holds a PEM block');
  if (/"private_key(_id)?"\s*:/.test(text)) problems.push('holds a private_key field');
  if (/"type"\s*:\s*"service_account"/.test(text)) problems.push('is a service-account key file');
  return problems;
}
