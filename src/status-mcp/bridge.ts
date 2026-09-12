import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JudgeSnapshot } from '../agent/judge.js';
import { redactAudit } from '../memory/audit.js';

const MAX_SNAPSHOT_BYTES = 262_144;

/** Passive, atomic, owner-only projection of the existing JudgeSnapshot. */
export async function publishJudgeSnapshot(path: string, snapshot: JudgeSnapshot): Promise<void> {
  const body = JSON.stringify(redactAudit(snapshot));
  if (Buffer.byteLength(body) > MAX_SNAPSHOT_BYTES) throw new RangeError('Status snapshot too large');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(body); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readJudgeSnapshot(path: string): Promise<JudgeSnapshot | null> {
  let size: number;
  try { size = (await stat(path)).size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (size > MAX_SNAPSHOT_BYTES) throw new RangeError('Status snapshot too large');
  const data = await readFile(path, 'utf8');
  if (Buffer.byteLength(data) > MAX_SNAPSHOT_BYTES) throw new RangeError('Status snapshot too large');
  const parsed: unknown = JSON.parse(data);
  if (!parsed || typeof parsed !== 'object' || !('functional' in parsed) || !('atk' in parsed)
    || !('reasoning' in parsed) || !('safety' in parsed)) throw new Error('Invalid status snapshot');
  return parsed as JudgeSnapshot;
}
