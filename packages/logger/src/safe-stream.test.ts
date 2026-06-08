import { Writable, type Writable as WritableStream } from "node:stream";
import { describe, expect, test } from "vitest";

import { wrapStreamWithErrorSwallowing } from "./safe-stream.js";

function failingWritable(): WritableStream {
  return {
    on: () => failingWritable(),
    write: () => {
      throw new Error("write failed");
    },
  } as unknown as WritableStream;
}

describe("wrapStreamWithErrorSwallowing", () => {
  test("swallows chunk-only write throws", () => {
    const wrapped = wrapStreamWithErrorSwallowing(failingWritable());
    expect(() => wrapped.write("payload")).not.toThrow();
  });

  test("swallows chunk+callback write throws", () => {
    const wrapped = wrapStreamWithErrorSwallowing(failingWritable());

    expect(() => {
      wrapped.write("payload", () => {
        // Callback may run after the wrapper completes the failed write.
      });
    }).not.toThrow();
  });

  test("swallows chunk+encoding write throws", () => {
    const wrapped = wrapStreamWithErrorSwallowing(failingWritable());
    expect(() => wrapped.write("payload", "utf8")).not.toThrow();
  });

  test("swallows chunk+encoding+callback write throws", () => {
    const wrapped = wrapStreamWithErrorSwallowing(failingWritable());

    expect(() => {
      wrapped.write("payload", "utf8", () => {
        // Callback may run after the wrapper completes the failed write.
      });
    }).not.toThrow();
  });

  test("swallows destination stream error events", () => {
    const destination = new Writable();
    wrapStreamWithErrorSwallowing(destination);
    expect(() => destination.emit("error", new Error("stream broke"))).not.toThrow();
  });
});
