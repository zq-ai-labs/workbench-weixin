import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'

/** Same rules as the workbench: every Chinese UI text goes through t() (or an upper-case label table) and has English. */
const ts = createRequire(import.meta.url)('typescript')
const english = JSON.parse(readFileSync(new URL('../client/en.json', import.meta.url), 'utf8'))
const files = readdirSync(new URL('../client/', import.meta.url)).filter(name => /\.tsx?$/.test(name) && name !== 'i18n.ts')

test('every UI text has English with the same placeholders', () => {
  const placeholders = text => (text.match(/\{\d+\}/g) || []).sort()
  for (const [key, value] of Object.entries(english)) {
    assert.ok(value.trim(), key)
    assert.doesNotMatch(value, /[一-鿿]/, key)
    assert.deepEqual(placeholders(value), placeholders(key), key)
  }
  assert.ok(files.includes('parts.tsx'))
  for (const file of files) {
    const source = readFileSync(new URL(`../client/${file}`, import.meta.url), 'utf8')
    const sf = ts.createSourceFile(file, source, 99, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const table = node => { for (let parent = node.parent; parent; parent = parent.parent) if (ts.isVariableDeclaration(parent)) return /^[A-Z][A-Z_]+$/.test(parent.name.getText(sf)); return false }
    const visit = node => {
      if (ts.isJsxText(node)) assert.doesNotMatch(node.getText(sf), /[一-鿿。]/, file)
      if (ts.isStringLiteral(node) && /[一-鿿]/.test(node.text) && !ts.isImportDeclaration(node.parent)) {
        let parent = node.parent
        while (ts.isConditionalExpression(parent)) parent = parent.parent
        const translated = ts.isCallExpression(parent) && parent.expression.getText(sf) === 't'
        // Message types from WeChat itself (e.g. 系统消息) are data, compared but never shown as UI text.
        const data = ts.isVariableDeclaration(node.parent) && node.parent.name.getText(sf) === 'SYSTEM_TYPE'
        if (data) return
        assert.ok(translated || table(node), `Unlocalized string in ${file}: ${node.text}`)
        assert.ok(english[node.text], `${file}: ${node.text}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
})
