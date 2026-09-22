import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('workflows are immutable, least privilege, main-only, and environment protected', () => {
  for (const path of ['.github/workflows/backup.yml', '.github/workflows/freshness.yml', '.github/workflows/verify.yml']) {
    const workflow = read(path)
    for (const [, ref] of workflow.matchAll(/uses: [^@\s]+@([^\s]+)/g)) {
      assert.match(ref, /^[0-9a-f]{40}$/)
    }
    assert.match(workflow, /permissions:\n  contents: read/)
  }
  const backup = read('.github/workflows/backup.yml')
  assert.match(backup, /\n  synthetic:[\s\S]*?run: bash scripts\/create-encrypted-logical-backup\.sh[\s\S]*?\n  production:[\s\S]*?run: bash scripts\/create-encrypted-logical-backup\.sh/)
  assert.match(backup, /environment: production-backup/)
  assert.match(backup, /github\.ref == 'refs\/heads\/main'/)
  assert.doesNotMatch(backup, /upload-artifact/)
  assert.doesNotMatch(backup, /AGE_(IDENTITY|PRIVATE_KEY).*secrets/)
})

test('published files contain no application-specific material or credentials', () => {
  const files = [
    'README.md',
    'OPERATIONS.md',
    'scripts/create-encrypted-logical-backup.sh',
    'scripts/blob-control.mjs',
  ]
  const source = files.map(read).join('\n')
  assert.doesNotMatch(source, /personal[ -]os|omargawi|profiles|prayer|commitments/i)
  assert.doesNotMatch(source, /postgres(?:ql)?:\/\/[^\s"']+@/i)
  assert.doesNotMatch(source, /BLOB_READ_WRITE_TOKEN\s*[:=]\s*['"][^$]/)
})

