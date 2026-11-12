/// <reference types="node" />
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import ts from "typescript";
import { parse } from "vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const BANNED_FILES = [
  "src/chains/ergo/hdKey.ts",
  "src/chains/ergo/transaction/prover.ts",
  "src/chains/ergo/signing.ts",
  "src/common/walletSecret.ts"
];
const BANNED_DIR = "src/extension/connector/multisig/";
const BANNED_PACKAGE = "@ergo-msig/core";
const CODE_EXTENSIONS = [".ts", ".vue", ".js", ".mjs"];

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

// The code of a file and, for a .vue file, the external scripts its blocks load through src.
function scriptOf(file: string): { code: string; srcs: string[] } {
  const text = readFileSync(file, "utf8");
  if (!file.endsWith(".vue")) return { code: text, srcs: [] };

  const { descriptor } = parse(text, { filename: file });
  const blocks = [descriptor.script, descriptor.scriptSetup];
  return {
    code: blocks.map((block) => block?.content).join("\n"),
    srcs: blocks.flatMap((block) => (block?.src ? [block.src] : []))
  };
}

// Every module specifier the file loads at run time: static imports, re-exports, import()
// and the src of a .vue script block. An explicit `import type` or `export type` loads nothing
// and is skipped.
function specifiersOf(file: string): string[] {
  const { code, srcs } = scriptOf(file);
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const found = [...srcs];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      found.push((node.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      found.push((node.moduleSpecifier as ts.StringLiteral).text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// A repo-relative path for a source file, the specifier itself for a package,
// or undefined for an asset (json, css, svg, wasm) or a declaration file, which load no code.
function resolveSpecifier(from: string, specifier: string): string | undefined {
  const bare = specifier.replace(/\?.*$/, "");
  let base: string;
  if (bare.startsWith(".")) base = resolve(dirname(from), bare);
  else if (bare.startsWith("@/")) base = resolve(ROOT, "src", bare.slice(2));
  else return bare;

  const candidates = [
    ...CODE_EXTENSIONS.map((ext) => base + ext),
    ...CODE_EXTENSIONS.map((ext) => resolve(base, "index" + ext))
  ];
  if (CODE_EXTENSIONS.includes(extname(base))) candidates.unshift(base);
  const hit = candidates.find(isFile);
  if (hit) return relative(ROOT, hit);
  if (isFile(base) || isFile(base + ".d.ts")) return undefined;

  throw new Error(`cannot resolve "${specifier}" imported by ${relative(ROOT, from)}`);
}

// Breadth-first walk from one entry. Maps every module it reaches to the chain that reached it.
function walk(entry: string): Map<string, string[]> {
  const chains = new Map([[entry, [entry]]]);
  const queue = [entry];
  for (let module = queue.shift(); module; module = queue.shift()) {
    if (!module.startsWith("src/")) continue;

    const from = resolve(ROOT, module);
    for (const specifier of specifiersOf(from)) {
      const target = resolveSpecifier(from, specifier);
      if (!target || chains.has(target)) continue;

      chains.set(target, [...chains.get(module)!, target]);
      queue.push(target);
    }
  }

  return chains;
}

describe("import walk", () => {
  // The background and the content scripts import no key module, no nonce store and no core, so a
  // secret can exist only in the connector window.
  it.each([
    "src/extension/background/background.ts",
    "src/extension/content-scripts/contentScript.ts",
    "src/extension/content-scripts/injected.ts"
  ])("%s reaches no key module, multisig window module or core", (entry) => {
    const reached = [...walk(entry)].filter(
      ([module]) =>
        BANNED_FILES.includes(module) ||
        module.startsWith(BANNED_DIR) ||
        module === BANNED_PACKAGE ||
        module.startsWith(BANNED_PACKAGE + "/")
    );

    expect(reached.map(([, chain]) => chain.join(" -> "))).toEqual([]);
  });

  // A walker that misses the @/ alias, a dynamic import() or a .vue script block would let the test
  // above pass with the guard blind.
  it("reaches the signing module from the connector window", () => {
    const chain = walk("src/extension/connector/main.ts").get("src/chains/ergo/signing.ts");

    expect(chain).toBeDefined();
  });
});
