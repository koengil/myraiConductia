// The only place the server logger touches the console (#474, design Q8). Vercel
// files a line by its console method, so the level is the method. Slice 2 replaces
// this body (a drain to CloudWatch needs no change here; GlitchTip would forward
// from here), and no call site moves.

export type Level = 'info' | 'warn' | 'error';

export function writeLine(level: Level, line: Readonly<Record<string, unknown>>): void {
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}
