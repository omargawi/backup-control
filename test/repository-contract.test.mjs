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

test('synthetic verification decrypts the downloaded Blob and validates exact contents before fail-safe cleanup', () => {
  const backup = read('.github/workflows/backup.yml')
  const blobControl = read('scripts/blob-control.mjs')

  assert.match(backup, /node scripts\/blob-control\.mjs store [^\n]+ "\$downloaded"/)
  assert.match(backup, /age --decrypt[\s\S]*?--identity "\$SYNTHETIC_AGE_IDENTITY"[\s\S]*?"\$RUNNER_TEMP\/synthetic-ciphertext\.age"/)
  assert.match(backup, /expected_members=.*SHA256SUMS data\.sql manifest\.json schema\.sql/)
  assert.match(backup, /sha256sum --check --strict SHA256SUMS/)
  assert.match(backup, /synthetic_backup_probe[\s\S]*?cmp - schema\.sql[\s\S]*?cmp - data\.sql/)
  assert.match(backup, /jq -e --arg source_ref "\$GITHUB_SHA"[\s\S]*?\.mode == "synthetic"[\s\S]*?\.schema_and_data == \["public"\][\s\S]*?\.schema_only == \["private"\]/)
  assert.match(backup, /- name: Delete synthetic ciphertext\n        if: always\(\) && steps\.store\.outputs\.pathname != ''/)
  assert.match(backup, /- name: Remove ephemeral synthetic verification files\n        if: always\(\)/)
  assert.doesNotMatch(backup, /cat .*synthetic-age-identity/)

  assert.match(blobControl, /storeCiphertext\(path, env = process\.env, downloadedPath\)/)
  assert.match(blobControl, /get\(uploaded\.pathname, \{ access: 'private', token, useCache: false \}\)/)
  assert.match(blobControl, /writeFile\(downloadedPath, verified\.bytes, \{ flag: 'wx', mode: 0o600 \}\)/)
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
