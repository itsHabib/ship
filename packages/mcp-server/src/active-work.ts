/**
 * Tracks asynchronous MCP handlers whose work must finish before the shared
 * SQLite store closes. Synchronous handlers need no registry: the event loop
 * cannot enter the transport-close callback until they return.
 */

export interface ActiveWorkTracker {
  drain: () => Promise<void>;
  track: <T>(work: Promise<T>) => Promise<T>;
}

export function createActiveWorkTracker(): ActiveWorkTracker {
  const pending = new Set<Promise<unknown>>();

  return {
    drain: async () => {
      // A settling handler may start another tracked promise before it returns.
      // Transport close stops new requests, so this loop converges while still
      // covering work registered during an earlier drain snapshot.
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    },
    track: <T>(work: Promise<T>): Promise<T> => {
      pending.add(work);
      void work.then(
        () => {
          pending.delete(work);
        },
        () => {
          pending.delete(work);
        },
      );
      return work;
    },
  };
}
