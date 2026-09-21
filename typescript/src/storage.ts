/**
 * Where the sealed cache lives.
 *
 * The contents are already encrypted and authenticated before they reach a
 * Storage, so an implementation only has to move bytes. It does not have to be
 * a secure location - that is the point of sealing them.
 */

import { mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Storage } from './types.js';

/**
 * A file on disk, written atomically.
 *
 * The temporary file plus rename matters: a licence cache truncated by a power
 * cut halfway through a write would leave the application unable to start, and
 * "reinstall to fix it" is not an acceptable answer to a flat battery.
 */
export class FileStorage implements Storage {
  constructor(private readonly path: string) {}

  async read(): Promise<Uint8Array | null> {
    try {
      return await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Anything else - a permission problem, a corrupt directory entry - is
      // treated the same way as "not activated yet": the caller re-activates.
      return null;
    }
  }

  async write(data: Uint8Array): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

/** For tests, and for a process that deliberately keeps nothing. */
export class MemoryStorage implements Storage {
  private data: Uint8Array | null = null;

  async read(): Promise<Uint8Array | null> {
    return this.data;
  }

  async write(data: Uint8Array): Promise<void> {
    this.data = Uint8Array.from(data);
  }

  async clear(): Promise<void> {
    this.data = null;
  }
}
