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

export function wrapStreamWithErrorSwallowing(
  stream: NodeJS.WritableStream,
): NodeJS.WritableStream {
  const destination = stream as WritableStream;
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
