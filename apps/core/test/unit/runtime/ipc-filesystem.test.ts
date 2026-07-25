import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];
const ARCHIVE_TTL_MS = 30 * 24 * 60 * 60_000;
const ARCHIVE_MAX_ENTRIES = 500;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('IPC error archive', () => {
  it('does not collide across cancellation lanes for the same request id', async () => {
    const archiveIpcErrorFile = await loadArchiveIpcErrorFile();
    const ipcBaseDir = makeRoot();
    const sourceAgentFolder = 'team';
    const filename = 'same-request.json';
    const archivedLanes = [
      'permission-cancellations',
      'question-cancellations',
    ];

    for (const lane of archivedLanes) {
      const claimedPath = path.join(
        ipcBaseDir,
        sourceAgentFolder,
        lane,
        `.processing-${filename}`,
      );
      fs.mkdirSync(path.dirname(claimedPath), { recursive: true });
      fs.writeFileSync(claimedPath, lane);
      archiveIpcErrorFile(ipcBaseDir, sourceAgentFolder, filename, claimedPath);
    }

    const archived = fs.readdirSync(path.join(ipcBaseDir, 'errors')).sort();
    expect(archived).toHaveLength(2);
    expect(
      archived.some((file) =>
        file.endsWith(
          `-${sourceAgentFolder}-permission-cancellations-${filename}`,
        ),
      ),
    ).toBe(true);
    expect(
      archived.some((file) =>
        file.endsWith(
          `-${sourceAgentFolder}-question-cancellations-${filename}`,
        ),
      ),
    ).toBe(true);
  });

  it('keeps a new archive when the source mtime predates the retention window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const archiveIpcErrorFile = await loadArchiveIpcErrorFile();
    const ipcBaseDir = makeRoot();
    const claimedPath = makeClaimedFile(ipcBaseDir, 'current.json');
    const oldMtime = new Date(Date.now() - ARCHIVE_TTL_MS - 1);
    fs.utimesSync(claimedPath, oldMtime, oldMtime);

    archiveIpcErrorFile(ipcBaseDir, 'team', 'current.json', claimedPath);

    expect(fs.readdirSync(path.join(ipcBaseDir, 'errors'))).toHaveLength(1);
  });

  it('measures expiry from the archive filename timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const archiveIpcErrorFile = await loadArchiveIpcErrorFile();
    const ipcBaseDir = makeRoot();
    const errorDir = path.join(ipcBaseDir, 'errors');
    fs.mkdirSync(errorDir, { recursive: true });
    const expiredArchive = makeArchivedFile(
      errorDir,
      Date.now() - ARCHIVE_TTL_MS - 1,
      'expired',
    );
    const retainedArchive = makeArchivedFile(
      errorDir,
      Date.now() - ARCHIVE_TTL_MS + 1,
      'retained',
    );
    const oldMtime = new Date(Date.now() - 2 * ARCHIVE_TTL_MS);
    fs.utimesSync(retainedArchive, oldMtime, oldMtime);

    archiveIpcErrorFile(
      ipcBaseDir,
      'team',
      'current.json',
      makeClaimedFile(ipcBaseDir, 'current.json'),
    );

    expect(fs.existsSync(expiredArchive)).toBe(false);
    expect(fs.existsSync(retainedArchive)).toBe(true);
  });

  it('bounds long archive names without breaking expiry pruning', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const archiveIpcErrorFile = await loadArchiveIpcErrorFile();
    const ipcBaseDir = makeRoot();
    const errorDir = path.join(ipcBaseDir, 'errors');
    const filename = `${'€'.repeat(65)}.json`;

    archiveIpcErrorFile(
      ipcBaseDir,
      'team',
      filename,
      makeClaimedFile(ipcBaseDir, filename),
    );

    const [archivedName] = fs.readdirSync(errorDir);
    expect(Buffer.byteLength(archivedName, 'utf8')).toBeLessThanOrEqual(255);
    expect(archivedName).toMatch(
      /^\d+-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-.+$/i,
    );

    vi.setSystemTime(Date.now() + ARCHIVE_TTL_MS + 1);
    archiveIpcErrorFile(
      ipcBaseDir,
      'team',
      'current.json',
      makeClaimedFile(ipcBaseDir, 'current.json'),
    );

    expect(fs.existsSync(path.join(errorDir, archivedName))).toBe(false);
  });

  it('keeps only the newest archives when one sweep exceeds the population cap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const archiveIpcErrorFile = await loadArchiveIpcErrorFile();
    const ipcBaseDir = makeRoot();
    const errorDir = path.join(ipcBaseDir, 'errors');
    fs.mkdirSync(errorDir, { recursive: true });
    const seededArchives = Array.from(
      { length: ARCHIVE_MAX_ENTRIES + 250 },
      (_, index) =>
        makeArchivedFile(
          errorDir,
          Date.now() - ARCHIVE_MAX_ENTRIES - 250 + index,
          `seeded-${index}`,
        ),
    );

    archiveIpcErrorFile(
      ipcBaseDir,
      'team',
      'current.json',
      makeClaimedFile(ipcBaseDir, 'current.json'),
    );

    expect(fs.readdirSync(errorDir)).toHaveLength(ARCHIVE_MAX_ENTRIES);
    const removedCount = seededArchives.length + 1 - ARCHIVE_MAX_ENTRIES;
    expect(
      seededArchives
        .slice(0, removedCount)
        .every((archive) => !fs.existsSync(archive)),
    ).toBe(true);
    expect(
      seededArchives
        .slice(removedCount)
        .every((archive) => fs.existsSync(archive)),
    ).toBe(true);
  });

  it('sweeps a burst that exceeds the population cap within one interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const archiveIpcErrorFile = await loadArchiveIpcErrorFile();
    const ipcBaseDir = makeRoot();
    const errorDir = path.join(ipcBaseDir, 'errors');

    for (let index = 0; index <= ARCHIVE_MAX_ENTRIES; index++) {
      const filename = `burst-${index}.json`;
      archiveIpcErrorFile(
        ipcBaseDir,
        'team',
        filename,
        makeClaimedFile(ipcBaseDir, filename),
      );
    }

    expect(fs.readdirSync(errorDir)).toHaveLength(ARCHIVE_MAX_ENTRIES);
  });

  it('keeps a full retained population capped during a burst', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const archiveIpcErrorFile = await loadArchiveIpcErrorFile();
    const ipcBaseDir = makeRoot();
    const errorDir = path.join(ipcBaseDir, 'errors');
    fs.mkdirSync(errorDir, { recursive: true });
    for (let index = 0; index < ARCHIVE_MAX_ENTRIES; index++) {
      makeArchivedFile(errorDir, Date.now() - index, `retained-${index}`);
    }

    for (let index = 0; index < 2; index++) {
      const filename = `burst-${index}.json`;
      archiveIpcErrorFile(
        ipcBaseDir,
        'team',
        filename,
        makeClaimedFile(ipcBaseDir, filename),
      );
    }

    expect(fs.readdirSync(errorDir)).toHaveLength(ARCHIVE_MAX_ENTRIES);
  });

  it('prunes an expired archive after many unmatched entries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const archiveIpcErrorFile = await loadArchiveIpcErrorFile();
    const ipcBaseDir = makeRoot();
    const errorDir = path.join(ipcBaseDir, 'errors');
    fs.mkdirSync(errorDir, { recursive: true });
    for (let index = 0; index < 100; index++) {
      fs.writeFileSync(path.join(errorDir, `unmatched-${index}.txt`), '');
    }
    const expiredArchive = makeArchivedFile(
      errorDir,
      Date.now() - ARCHIVE_TTL_MS - 1,
      'expired',
    );
    const entries = fs.readdirSync(errorDir, { withFileTypes: true });
    const expiredName = path.basename(expiredArchive);
    vi.spyOn(fs, 'readdirSync').mockReturnValueOnce([
      ...entries.filter((entry) => entry.name !== expiredName),
      ...entries.filter((entry) => entry.name === expiredName),
    ]);

    archiveIpcErrorFile(
      ipcBaseDir,
      'team',
      'current.json',
      makeClaimedFile(ipcBaseDir, 'current.json'),
    );

    expect(fs.existsSync(expiredArchive)).toBe(false);
    expect(fs.existsSync(path.join(errorDir, 'unmatched-0.txt'))).toBe(true);
  });

  it('keeps a completed archive when pruning fails', async () => {
    const archiveIpcErrorFile = await loadArchiveIpcErrorFile();
    const ipcBaseDir = makeRoot();
    const claimedPath = makeClaimedFile(ipcBaseDir, 'current.json');
    const readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw new Error('prune failed');
    });

    expect(() =>
      archiveIpcErrorFile(ipcBaseDir, 'team', 'current.json', claimedPath),
    ).not.toThrow();
    readdirSpy.mockRestore();

    expect(fs.existsSync(claimedPath)).toBe(false);
    expect(fs.readdirSync(path.join(ipcBaseDir, 'errors'))).toHaveLength(1);
  });

  it('throttles archive sweeps within the sweep interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const archiveIpcErrorFile = await loadArchiveIpcErrorFile();
    const ipcBaseDir = makeRoot();
    const readdirSpy = vi.spyOn(fs, 'readdirSync');

    for (const filename of ['first.json', 'second.json']) {
      archiveIpcErrorFile(
        ipcBaseDir,
        'team',
        filename,
        makeClaimedFile(ipcBaseDir, filename),
      );
    }

    expect(readdirSpy).toHaveBeenCalledOnce();
  });
});

async function loadArchiveIpcErrorFile() {
  vi.resetModules();
  return (await import('@core/runtime/ipc-filesystem.js')).archiveIpcErrorFile;
}

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-ipc-filesystem-'));
  tempDirs.push(root);
  return root;
}

function makeClaimedFile(ipcBaseDir: string, filename: string): string {
  const claimedPath = path.join(
    ipcBaseDir,
    'team',
    'messages',
    `.processing-${filename}`,
  );
  fs.mkdirSync(path.dirname(claimedPath), { recursive: true });
  fs.writeFileSync(claimedPath, '{}');
  return claimedPath;
}

function makeArchivedFile(
  errorDir: string,
  archivedAt: number,
  suffix: string,
): string {
  const archivePath = path.join(
    errorDir,
    `${archivedAt}-00000000-0000-4000-8000-000000000000-team-messages-${suffix}.json`,
  );
  fs.writeFileSync(archivePath, '{}');
  return archivePath;
}
