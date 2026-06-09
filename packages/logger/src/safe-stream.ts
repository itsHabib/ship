import { Writable, type Writable as WritableStream } from "node:stream";

function invokeCallback(callback?: (error?: Error | null) => void): void {
  if (callback !== undefined) {
    callback();
  }
}

function forwardWrite(
  stream: WritableStream,
  chunk: Buffer | string,
  encoding: BufferEncoding,
  callback?: (error?: Error | null) => void,
): void {
  try {
    stream.write(chunk, encoding, () => {
      invokeCallback(callback);
    });
  } catch {
    invokeCallback(callback);
  }
}

// Destinations we have already attached a swallowing error listener to. Guards
// against listener pileup (and MaxListenersExceededWarning) when many loggers
// wrap a shared destination like process.stderr.
const guardedDestinations = new WeakSet();

function guardDestinationErrors(destination: WritableStream): void {
  if (guardedDestinations.has(destination)) {
    return;
  }
  guardedDestinations.add(destination);
  destination.on("error", () => {
    // Async write failures (e.g. EPIPE) surface as 'error' on the destination,
    // not the wrapper. Swallow them so an unhandled 'error' never crashes the
    // process — diagnostics must never throw into business logic.
  });
}

export function wrapStreamWithErrorSwallowing(
  stream: NodeJS.WritableStream,
): NodeJS.WritableStream {
  const destination = stream as WritableStream;
  guardDestinationErrors(destination);

  const wrapper = new Writable({
    write(chunk: Buffer | string, encoding, callback) {
      forwardWrite(destination, chunk, encoding, callback);
    },
  });

  wrapper.on("error", () => {
    // Swallow wrapper errors so diagnostics never throw into business logic.
  });

  return wrapper;
}
