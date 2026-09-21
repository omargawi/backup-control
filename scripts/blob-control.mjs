#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { basename } from 'node:path'
import { del, get, head, list, put } from '@vercel/blob'

export const defaults = Object.freeze({
  maxAgeHours: 26,
  maxSingleBytes: 50_000_000,
  maxTotalBytes: 400_000_000,
  minimumRetained: 2,
  retentionCount: 7,
})

function positiveInteger(name, value, fallback) {
  const parsed = Number(value ?? fallback)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

export function configuration(env = process.env) {
  const prefix = env.BACKUP_BLOB_PREFIX ?? 'logical-backups/'
  if (
    !/^[a-z0-9][a-z0-9/_-]*\/$/.test(prefix) ||
    prefix.includes('..') ||
    prefix.startsWith('/')
  ) {
    throw new Error('BACKUP_BLOB_PREFIX must be a safe relative directory')
  }

  const parsed = {
    prefix,
    maxAgeHours: positiveInteger('BACKUP_MAX_AGE_HOURS', env.BACKUP_MAX_AGE_HOURS, defaults.maxAgeHours),
    maxSingleBytes: positiveInteger('BACKUP_MAX_SINGLE_BYTES', env.BACKUP_MAX_SINGLE_BYTES, defaults.maxSingleBytes),
    maxTotalBytes: positiveInteger('BACKUP_MAX_TOTAL_BYTES', env.BACKUP_MAX_TOTAL_BYTES, defaults.maxTotalBytes),
    minimumRetained: positiveInteger('BACKUP_MINIMUM_RETAINED', env.BACKUP_MINIMUM_RETAINED, defaults.minimumRetained),
    retentionCount: positiveInteger('BACKUP_RETENTION_COUNT', env.BACKUP_RETENTION_COUNT, defaults.retentionCount),
  }
  if (parsed.retentionCount < parsed.minimumRetained) {
    throw new Error('BACKUP_RETENTION_COUNT cannot be lower than BACKUP_MINIMUM_RETAINED')
  }
  return parsed
}

export function isManagedCiphertext(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return false
  const name = pathname.slice(prefix.length)
  return /^logical-backup-\d{8}T\d{6}Z-[0-9a-f]{64}\.tar\.gz\.age$/.test(name)
}

export function expectedHash(pathname) {
  const match = basename(pathname).match(/-([0-9a-f]{64})\.tar\.gz\.age$/)
  if (!match) throw new Error(`Unrecognized ciphertext pathname: ${pathname}`)
  return match[1]
}

export function capacityPlan(blobs, incomingBytes, config) {
  if (incomingBytes > config.maxSingleBytes) {
    throw new Error('Ciphertext exceeds the configured single-backup limit')
  }
  const total = blobs.reduce((sum, blob) => sum + blob.size, 0)
  if (total + incomingBytes <= config.maxTotalBytes) return []

  const candidates = blobs
    .filter((blob) => isManagedCiphertext(blob.pathname, config.prefix))
    .sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt))
  const plan = []
  let projected = total + incomingBytes
  while (projected > config.maxTotalBytes && candidates.length > config.minimumRetained) {
    const oldest = candidates.shift()
    plan.push(oldest)
    projected -= oldest.size
  }
  if (projected > config.maxTotalBytes) {
    throw new Error('Whole-store capacity guard refused the upload')
  }
  return plan
}

export function retentionPlan(blobs, config) {
  const managed = blobs
    .filter((blob) => isManagedCiphertext(blob.pathname, config.prefix))
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
  return managed.slice(config.retentionCount)
}

async function listAll(token) {
  const blobs = []
  let cursor
  do {
    const page = await list({ token, cursor, limit: 1000 })
    blobs.push(...page.blobs)
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)
  return blobs
}

async function deleteSafely(blob, token) {
  await del(blob.pathname, { token, ifMatch: blob.etag })
}

async function hashStream(stream) {
  const hash = createHash('sha256')
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

export async function storeCiphertext(path, env = process.env) {
  const token = env.BLOB_READ_WRITE_TOKEN
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is required')
  const config = configuration(env)
  const size = statSync(path).size
  let blobs = await listAll(token)
  const unexpected = blobs.find(
    (blob) => blob.pathname.startsWith(config.prefix) && !isManagedCiphertext(blob.pathname, config.prefix),
  )
  if (unexpected) throw new Error(`Unrecognized object in managed namespace: ${unexpected.pathname}`)

  for (const candidate of capacityPlan(blobs, size, config)) {
    await deleteSafely(candidate, token)
  }
  blobs = await listAll(token)
  if (blobs.reduce((sum, blob) => sum + blob.size, 0) + size > config.maxTotalBytes) {
    throw new Error('Whole-store capacity changed while preparing the upload')
  }

  const localHash = expectedHash(path)
  const pathname = `${config.prefix}${basename(path)}`
  let uploaded
  try {
    uploaded = await put(pathname, createReadStream(path), {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: 'application/octet-stream',
      cacheControlMaxAge: 60,
      token,
    })
    const metadata = await head(uploaded.pathname, { token })
    if (metadata.pathname !== pathname || metadata.size !== size) {
      throw new Error('Uploaded ciphertext metadata does not match the local artifact')
    }
    const downloaded = await get(uploaded.pathname, { access: 'private', token, useCache: false })
    if (!downloaded?.stream || (await hashStream(downloaded.stream)) !== localHash) {
      throw new Error('Authenticated ciphertext integrity verification failed')
    }
  } catch (error) {
    if (uploaded?.pathname) await del(uploaded.pathname, { token })
    throw error
  }

  blobs = await listAll(token)
  for (const candidate of retentionPlan(blobs, config)) {
    await deleteSafely(candidate, token)
  }
  return uploaded.pathname
}

export async function verifyFreshness(env = process.env) {
  const token = env.BLOB_READ_WRITE_TOKEN
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is required')
  const config = configuration(env)
  const allBlobs = await listAll(token)
  const unexpected = allBlobs.find(
    (blob) => blob.pathname.startsWith(config.prefix) && !isManagedCiphertext(blob.pathname, config.prefix),
  )
  if (unexpected) throw new Error(`Unrecognized object in managed namespace: ${unexpected.pathname}`)
  const blobs = allBlobs
    .filter((blob) => isManagedCiphertext(blob.pathname, config.prefix))
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
  if (!blobs.length) throw new Error('No managed ciphertext exists')
  const ageMilliseconds = Date.now() - new Date(blobs[0].uploadedAt).getTime()
  if (ageMilliseconds < -300_000 || ageMilliseconds > config.maxAgeHours * 3_600_000) {
    throw new Error('Latest ciphertext is outside the configured freshness window')
  }
  return blobs[0].pathname
}

async function main() {
  const [command, argument] = process.argv.slice(2)
  if (command === 'store' && argument) {
    console.log(await storeCiphertext(argument))
    return
  }
  if (command === 'freshness') {
    console.log(await verifyFreshness())
    return
  }
  if (command === 'delete' && argument) {
    const token = process.env.BLOB_READ_WRITE_TOKEN
    if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is required')
    const config = configuration()
    if (!isManagedCiphertext(argument, config.prefix)) throw new Error('Refusing to delete an unmanaged pathname')
    const metadata = await head(argument, { token })
    await del(argument, { token, ifMatch: metadata.etag })
    return
  }
  throw new Error('usage: blob-control.mjs store FILE | freshness | delete PATHNAME')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
