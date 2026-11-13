// Raw terminal input as named keys. A chunk can end in the middle of an escape sequence and a lone Escape looks
// like the start of one, so the decoder keeps what it can't decide yet until more arrives or `flush` is called.

export type Key = {
  name: "up" | "down" | "left" | "right" | "space" | "enter" | "ctrl-c" | "ctrl-d" | "escape" | "backspace" | "char";
  char?: string;
};

/** How long a lone Escape waits for the rest of a sequence before it counts as the Escape key. */
export const ESCAPE_TIMEOUT_MS = 50;

const ARROWS: Readonly<Record<string, Key["name"]>> = { A: "up", B: "down", C: "right", D: "left" };
// Legacy Windows console scan codes after a 0x00 / 0xE0 prefix.
const SCAN_CODES: Readonly<Record<string, Key["name"]>> = { H: "up", P: "down", M: "right", K: "left" };

export class KeyDecoder {
  private pending = "";

  /** Keys decoded from `text`; an undecided tail (a split sequence) is kept for the next call. */
  push(text: string): Key[] {
    const input = this.pending + text;
    this.pending = "";
    const keys: Key[] = [];
    const chars = Array.from(input);
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i] as string;
      if (ch === "\u001b") {
        const next = chars[i + 1];
        if (next === undefined) {
          this.pending = ch;
          break;
        }
        if (next === "[" || next === "O") {
          // CSI: parameters (0x30-0x3F), intermediates (0x20-0x2F), then one final byte (0x40-0x7E).
          let j = i + 2;
          while (j < chars.length) {
            const code = (chars[j] as string).charCodeAt(0);
            if (code >= 0x40 && code <= 0x7e) break;
            j += 1;
          }
          if (j >= chars.length) {
            this.pending = chars.slice(i).join("");
            break;
          }
          const final = chars[j] as string;
          const name = ARROWS[final];
          if (name !== undefined && j === i + 2) keys.push({ name });
          i = j;
          continue;
        }
        keys.push({ name: "escape" });
        continue;
      }
      if (ch === "\u0000" || ch === "à") {
        const next = chars[i + 1];
        if (next === undefined) {
          this.pending = ch;
          break;
        }
        const name = SCAN_CODES[next];
        if (name !== undefined) {
          keys.push({ name });
          i += 1;
        }
        continue;
      }
      if (ch === "\r") {
        if (chars[i + 1] === "\n") i += 1;
        keys.push({ name: "enter" });
      } else if (ch === "\n") keys.push({ name: "enter" });
      else if (ch === "\u0003") keys.push({ name: "ctrl-c" });
      else if (ch === "\u0004") keys.push({ name: "ctrl-d" });
      else if (ch === "\u007f" || ch === "\b") keys.push({ name: "backspace" });
      else if (ch === " ") keys.push({ name: "space", char: " " });
      else if (ch.charCodeAt(0) >= 0x20) keys.push({ name: "char", char: ch });
    }
    return keys;
  }

  /** Whether an undecided tail is waiting (the reader starts the Escape timer for it). */
  hasPending(): boolean {
    return this.pending !== "";
  }

  /** Resolves the undecided tail: a lone Escape is the Escape key, anything else is dropped. */
  flush(): Key[] {
    const tail = this.pending;
    this.pending = "";
    return tail === "\u001b" ? [{ name: "escape" }] : [];
  }
}
