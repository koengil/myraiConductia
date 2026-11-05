export function refuseSandboxLiveInCi(live: boolean, env: Record<string, string | undefined> = process.env): void {
  if (live && env.CI?.trim().toLowerCase() === 'true') {
    throw new Error('Refusing: sandbox --live/--apply in CI');
  }
}
