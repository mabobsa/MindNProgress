import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ARTIFACT_CHUNK_BYTES, identifier, jsonFile, remoteArtifactKind, saveJson, workspaceError } from './remoteWorkspaceProtocol.mjs'

export async function digestFile(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export class RemoteWorkspaceArtifacts {
  constructor(root, { maxBytes = 8 * 1024 ** 3 } = {}) { this.root = path.resolve(root); this.maxBytes = maxBytes }
  directory(leaseId, kind) {
    identifier(leaseId)
    remoteArtifactKind(kind)
    return path.join(this.root, leaseId, kind)
  }
  file(leaseId, kind) { return path.join(this.directory(leaseId, kind), 'artifact.bundle') }
  async cleanup(leaseId) {
    identifier(leaseId)
    await rm(path.join(this.root, leaseId), { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
  }
  async manifest(leaseId, kind) {
    const manifest = await jsonFile(path.join(this.directory(leaseId, kind), 'manifest.json'))
    if (!manifest) throw workspaceError('REMOTE_ARTIFACT_NOT_FOUND')
    return manifest
  }
  validate(manifest) {
    if (!Number.isSafeInteger(manifest?.size) || manifest.size < 1 || manifest.size > this.maxBytes
      || !/^[a-f0-9]{64}$/.test(manifest?.sha256 ?? '')) throw workspaceError('REMOTE_ARTIFACT_MANIFEST_INVALID')
    return { size: manifest.size, sha256: manifest.sha256, chunkBytes: ARTIFACT_CHUNK_BYTES }
  }
  async publish(leaseId, kind) {
    const file = this.file(leaseId, kind)
    const manifest = this.validate({ size: (await stat(file)).size, sha256: await digestFile(file) })
    await saveJson(path.join(this.directory(leaseId, kind), 'manifest.json'), manifest)
    return manifest
  }
  async chunk(leaseId, kind, index) {
    const manifest = await this.manifest(leaseId, kind)
    this.index(manifest, index)
    const buffer = Buffer.alloc(Math.min(ARTIFACT_CHUNK_BYTES, manifest.size - index * ARTIFACT_CHUNK_BYTES))
    const file = await open(this.file(leaseId, kind), 'r')
    try {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, index * ARTIFACT_CHUNK_BYTES)
      if (bytesRead !== buffer.length) throw workspaceError('REMOTE_ARTIFACT_TRUNCATED')
    } finally { await file.close() }
    return { index, data: buffer.toString('base64'), sha256: createHash('sha256').update(buffer).digest('hex') }
  }
  index(manifest, index) {
    if (!Number.isSafeInteger(index) || index < 0 || index * ARTIFACT_CHUNK_BYTES >= manifest.size) {
      throw workspaceError('REMOTE_ARTIFACT_CHUNK_INVALID')
    }
  }
  async receive(leaseId, kind, manifest, chunk) {
    const normalized = this.validate(manifest)
    this.index(normalized, chunk?.index)
    const directory = this.directory(leaseId, kind)
    const prior = await jsonFile(path.join(directory, 'upload.json'))
    if (prior && (prior.size !== normalized.size || prior.sha256 !== normalized.sha256)) {
      throw workspaceError('REMOTE_ARTIFACT_UPLOAD_CONFLICT')
    }
    const expectedSize = Math.min(ARTIFACT_CHUNK_BYTES, normalized.size - chunk.index * ARTIFACT_CHUNK_BYTES)
    if (typeof chunk.data !== 'string' || chunk.data.length > Math.ceil(ARTIFACT_CHUNK_BYTES / 3) * 4
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.data)) throw workspaceError('REMOTE_ARTIFACT_CHUNK_INVALID')
    const buffer = Buffer.from(chunk.data, 'base64')
    if (buffer.length !== expectedSize || createHash('sha256').update(buffer).digest('hex') !== chunk.sha256) {
      throw workspaceError('REMOTE_ARTIFACT_HASH_MISMATCH')
    }
    await mkdir(directory, { recursive: true })
    if (!prior) await saveJson(path.join(directory, 'upload.json'), normalized)
    const target = path.join(directory, `chunk-${chunk.index}`)
    const existing = await readFile(target).catch((error) => { if (error.code !== 'ENOENT') throw error; return null })
    if (existing && !existing.equals(buffer)) throw workspaceError('REMOTE_ARTIFACT_UPLOAD_CONFLICT')
    if (!existing) {
      await writeFile(`${target}.tmp`, buffer, { mode: 0o600 })
      await rename(`${target}.tmp`, target)
    }
    return { received: true, index: chunk.index }
  }
  async finish(leaseId, kind) {
    const directory = this.directory(leaseId, kind)
    const manifest = this.validate(await jsonFile(path.join(directory, 'upload.json')))
    const temporary = `${this.file(leaseId, kind)}.assembling`
    const output = await open(temporary, 'w', 0o600)
    const hash = createHash('sha256')
    let size = 0
    try {
      for (let index = 0; index * ARTIFACT_CHUNK_BYTES < manifest.size; index += 1) {
        const chunk = await readFile(path.join(directory, `chunk-${index}`))
        hash.update(chunk); size += chunk.length
        await output.writeFile(chunk)
      }
    } finally { await output.close() }
    if (size !== manifest.size || hash.digest('hex') !== manifest.sha256) throw workspaceError('REMOTE_ARTIFACT_HASH_MISMATCH')
    await rename(temporary, this.file(leaseId, kind))
    await saveJson(path.join(directory, 'manifest.json'), manifest)
    return manifest
  }
}
