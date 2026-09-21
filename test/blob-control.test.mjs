import assert from 'node:assert/strict'
import test from 'node:test'
import {
  capacityPlan,
  configuration,
  defaults,
  expectedHash,
  isManagedCiphertext,
  retentionPlan,
} from '../scripts/blob-control.mjs'

const hash = 'a'.repeat(64)
const prefix = 'logical-backups/'
const blob = (stamp, size = 10) => ({
  pathname: `${prefix}logical-backup-${stamp}-${hash}.tar.gz.age`,
  size,
  uploadedAt: new Date(
    stamp.replace(
      /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,
      '$1-$2-$3T$4:$5:$6Z',
    ),
  ),
  etag: stamp,
})

test('accepts only bounded relative prefixes and managed ciphertext names', () => {
  assert.equal(configuration({}).prefix, prefix)
  assert.throws(() => configuration({ BACKUP_BLOB_PREFIX: '../escape/' }))
  assert.equal(isManagedCiphertext(blob('20260921T010101Z').pathname, prefix), true)
  assert.equal(isManagedCiphertext(`${prefix}receipt.json`, prefix), false)
  assert.equal(expectedHash(blob('20260921T010101Z').pathname), hash)
})

test('fails closed on a single oversized backup', () => {
  assert.throws(() => capacityPlan([], defaults.maxSingleBytes + 1, { ...defaults, prefix }))
})

test('capacity pruning preserves the newest minimum backup set', () => {
  const config = { ...defaults, prefix, maxTotalBytes: 100, minimumRetained: 2 }
  const blobs = [
    blob('20260918T010101Z', 30),
    blob('20260919T010101Z', 30),
    blob('20260920T010101Z', 30),
  ]
  assert.deepEqual(capacityPlan(blobs, 20, config).map((item) => item.etag), ['20260918T010101Z'])
})

test('capacity guard counts unmanaged objects but never deletes them', () => {
  const config = { ...defaults, prefix, maxTotalBytes: 100, minimumRetained: 2 }
  const blobs = [
    { pathname: 'other/object', size: 50, uploadedAt: new Date(), etag: 'other' },
    blob('20260919T010101Z', 20),
    blob('20260920T010101Z', 20),
  ]
  assert.throws(() => capacityPlan(blobs, 20, config), /capacity guard/)
})

test('retention deletes only the oldest managed ciphertext', () => {
  const config = { ...defaults, prefix, retentionCount: 2 }
  const blobs = [
    blob('20260918T010101Z'),
    blob('20260920T010101Z'),
    blob('20260919T010101Z'),
    { pathname: `${prefix}notes.txt`, size: 1, uploadedAt: new Date(), etag: 'notes' },
  ]
  assert.deepEqual(retentionPlan(blobs, config).map((item) => item.etag), ['20260918T010101Z'])
})
