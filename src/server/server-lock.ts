import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Atomic single-process ownership without importing the optional model
 * runtime. A dead local PID may be recovered; a live/unknown owner fails closed. */
export async function acquireServerLock(root: string): Promise<() => Promise<void>> {
  const path = join(root, 'server.lock'), token = randomUUID();
  const contents = JSON.stringify({ pid: process.pid, token });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600); await handle.writeFile(contents); await handle.sync();
      let released = false;
      return async () => {
        if (released) return; released = true;
        await handle.close();
        try { if (await readFile(path, 'utf8') === contents) await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const before = await readFile(path, 'utf8'); let owner: unknown;
      try { owner = JSON.parse(before); } catch { throw new Error('Data directory lock is invalid; inspect server.lock before removing it'); }
      const pid = (owner as { pid?: unknown })?.pid;
      if (!Number.isSafeInteger(pid) || (pid as number) <= 0) throw new Error('Data directory lock has an unknown owner');
      try { process.kill(pid as number, 0); throw new Error('Another server owns this data directory'); }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe; }
      if (await readFile(path, 'utf8') !== before) throw new Error('Data directory ownership changed; retry startup');
      await unlink(path);
    }
  }
  throw new Error('Could not acquire the data directory lock');
}
