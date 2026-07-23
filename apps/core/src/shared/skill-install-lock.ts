// Serializes skill writes and rollback compare+restore per materialization
// key across every in-process writer (command installs, permission-review
// installs, the Control API upload route). The runtime handles these in one
// host process, so an in-process mutex makes check-then-write sections
// atomic vs each other; cross-process coordination is the documented
// follow-up (durable versioned CAS).
const skillMaterializationLocks = new Map<string, Promise<unknown>>();

export async function withSkillMaterializationLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = skillMaterializationLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const sentinel = run.then(
    () => undefined,
    () => undefined,
  );
  skillMaterializationLocks.set(key, sentinel);
  void sentinel.then(() => {
    // Keys are request-derived; drop settled entries so the registry stays
    // bounded. A queued writer replaces the sentinel before this runs, so
    // the equality check keeps serialization intact.
    if (skillMaterializationLocks.get(key) === sentinel) {
      skillMaterializationLocks.delete(key);
    }
  });
  return run;
}
