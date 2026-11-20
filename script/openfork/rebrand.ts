#!/usr/bin/env bun
/**
 * OpenFork rebrand pass.
 *
 * Rewrites the user-visible product name "OpenCode" -> "OpenFork" (and CLI hints
 * like `opencode run` -> `openfork run`) but ONLY inside string literals,
 * template strings and JSX text, so code identifiers, package scopes
 * (`@opencode/*`), external services (OpenCode Zen/Go/Console…) and domains
 * (opencode.ai) are left untouched. Idempotent: safe to rerun after merging
 * upstream.
 *
 * Usage: bun script/openfork/rebrand.ts [--dry] <dir>...
 */
import ts from "typescript"
import { Glob } from "bun"
import path from "path"

// Names of upstream services/products that must keep their real name.
const KEEP_AFTER = ["Console", "Consolen", "Consoleen", "Go", "Zen", "Free", "Data", "Black", "Enterprise", "Anomaly"]
const brandRe = new RegExp(`(?<![\\w.@/-])OpenCode\\b(?!\\s+(?:${KEEP_AFTER.join("|")})\\b)(?![-.]?[A-Za-z0-9_])`, "g")
// `opencode <subcommand>` / `opencode2 <subcommand>` in prose, not part of a path, scope, id or domain.
const cliRe = /(?<![\w@./:-])opencode2?(?= [a-z-]+\b)(?! (?:go|zen|console)\b)/g

function rewrite(text: string) {
  return text.replace(brandRe, "OpenFork").replace(cliRe, "openfork")
}

function transform(source: string, file: string) {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  const edits: { start: number; end: number; text: string }[] = []
  const visit = (node: ts.Node) => {
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
      case ts.SyntaxKind.JsxText: {
        // Module specifiers (imports/exports) are code, not text.
        if (ts.isStringLiteral(node) && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent) || ts.isExternalModuleReference(node.parent) || ts.isLiteralTypeNode(node.parent) && !!node.parent.parent && ts.isImportTypeNode(node.parent.parent))) break
        // Keys like { "opencode": ... } and property access ids are data, keep them.
        if (ts.isStringLiteral(node) && ts.isPropertyAssignment(node.parent) && node.parent.name === node) break
        const start = node.getStart(sf)
        const end = node.getEnd()
        const raw = source.slice(start, end)
        const next = rewrite(raw)
        if (next !== raw) edits.push({ start, end, text: next })
        break
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  edits.sort((a, b) => b.start - a.start)
  let out = source
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return { out, count: edits.length }
}

const dry = process.argv.includes("--dry")
const dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"))
let total = 0
for (const dir of dirs) {
  for await (const rel of new Glob("**/*.{ts,tsx}").scan({ cwd: dir, onlyFiles: true })) {
    if (/(^|\/)(node_modules|dist|\.cache)\//.test(rel) || /\.(test|spec)\.tsx?$/.test(rel) || rel.endsWith(".d.ts")) continue
    const file = path.join(dir, rel)
    const source = await Bun.file(file).text()
    if (!/OpenCode|opencode/.test(source)) continue
    const { out, count } = transform(source, file)
    if (!count) continue
    total += count
    console.log(`${count}\t${file}`)
    if (!dry) await Bun.write(file, out)
  }
}
console.log(`${dry ? "would change" : "changed"} ${total} literals`)
