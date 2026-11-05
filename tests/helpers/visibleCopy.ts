import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * Every string a source file can put in front of a reader: string literals,
 * template text and JSX text. Comments are never visited, so a maintainer note
 * is not copy. Parsed with the TypeScript compiler, so a quote inside a
 * comment or a regex cannot confuse it.
 */
export type CopyString = { file: string; line: number; text: string };

export function copyStringsOf(file: string, source: string): CopyString[] {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const out: CopyString[] = [];
  const add = (node: ts.Node, text: string) => {
    if (!text.trim()) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ file, line: line + 1, text });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) add(node, node.text);
    else if (ts.isJsxText(node)) add(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Source files under `roots`, minus generated data and type-only files. */
export function sourceFiles(roots: string[], skip: (path: string) => boolean = () => false): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name) && !skip(path)) files.push(path);
    }
  };
  for (const root of roots) walk(root);
  return files.sort();
}

export function allCopyStrings(roots: string[], skip?: (path: string) => boolean): CopyString[] {
  return sourceFiles(roots, skip).flatMap((file) => copyStringsOf(file, readFileSync(file, 'utf8')));
}
