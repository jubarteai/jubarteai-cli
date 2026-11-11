import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { redactSecrets, safeForDisplay, transportErrorEnvelope, writeJson } from "./output.js";

function collect(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let text = "";
  stream.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  return { stream, text: () => text };
}

describe("writeJson", () => {
  it("writes one compact line ending in a newline", () => {
    const out = collect();
    writeJson(out.stream, { messages: [], result: { a: 1, b: [1, 2] } }, { pretty: false });
    expect(out.text()).toBe('{"messages":[],"result":{"a":1,"b":[1,2]}}\n');
  });

  it("indents by two spaces with pretty", () => {
    const out = collect();
    writeJson(out.stream, { a: { b: 1 } }, { pretty: true });
    expect(out.text()).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n');
  });

  it("keeps newlines inside strings escaped so output stays one line", () => {
    const out = collect();
    writeJson(out.stream, { text: "a\nb" }, { pretty: false });
    expect(out.text().split("\n")).toEqual(['{"text":"a\\nb"}', ""]);
  });

  it("writes null for undefined", () => {
    const out = collect();
    writeJson(out.stream, undefined, { pretty: false });
    expect(out.text()).toBe("null\n");
  });
});

describe("transportErrorEnvelope", () => {
  it("has messages first, then error and code", () => {
    const envelope = transportErrorEnvelope("network_error", "Could not reach JubarteAI.");
    expect(JSON.stringify(envelope)).toBe('{"messages":[],"error":"Could not reach JubarteAI.","code":"network_error"}');
  });
});

describe("redactSecrets", () => {
  it("redacts keys, login codes and watch tokens", () => {
    const text = "key jba_FAKEFAKEFAKEFAKE1234 code jbc_abc-DEF_123 watch jbw_zzzzzzzz done";
    const redacted = redactSecrets(text);
    expect(redacted).toBe("key [redacted] code [redacted] watch [redacted] done");
  });

  it("leaves ordinary text alone", () => {
    expect(redactSecrets("Not signed in. Run: jubarteai login")).toBe("Not signed in. Run: jubarteai login");
  });
});

describe("safeForDisplay", () => {
  it("replaces C0, DEL, C1, bidi and separator characters", () => {
    const raw = "a\u0000b\u001bc\u007fd\u0085e\u009bf\u202eg\u200bh\u2028i\nj";
    expect(safeForDisplay(raw)).toBe("a?b?c?d?e?f?g?h?i?j");
  });

  it("keeps printable text, including non-ASCII letters", () => {
    expect(safeForDisplay("sök-ñ")).toBe("sök-ñ");
  });

  it("redacts secrets before cutting, and cuts to the limit", () => {
    expect(safeForDisplay("jba_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE")).toBe("[redacted]");
    expect(safeForDisplay("x".repeat(100))).toHaveLength(40);
    expect(safeForDisplay("abcdef", 3)).toBe("abc");
  });
});
