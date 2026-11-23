// Turns a transcript like "set limit five hundred" into a structured command.
// The transcript is only ever PROPOSED to the user; nothing is written from voice
// without a press to confirm, and the limit is validated like any other input.

import { MAX_DAILY_LIMIT, validateLimit } from "./limits.ts";

export type VoiceCommand =
  | { kind: "set_limit"; amount: number }
  | { kind: "out_of_range"; amount: number }
  | { kind: "unclear" };

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const FILLER = new Set(["and", "dollars", "dollar", "bucks", "usd", "us", "of", "to", "at", "the"]);

/** Parses a run of number words into a value; returns null if the run is malformed. */
function parseWordRun(tokens: string[]): number | null {
  let total = 0;
  let current = 0;
  for (const t of tokens) {
    if (t in UNITS) current += UNITS[t]!;
    else if (t in TENS) current += TENS[t]!;
    else if (t === "hundred") current = (current || 1) * 100;
    else if (t === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
    } else if (t === "million") {
      total += (current || 1) * 1_000_000;
      current = 0;
    } else return null;
  }
  return total + current;
}

function isNumberWord(t: string, next: string | undefined): boolean {
  if (t in UNITS || t in TENS || t === "hundred" || t === "thousand" || t === "million") return true;
  // "a thousand", "a hundred"
  return t === "a" && (next === "hundred" || next === "thousand");
}

/** Finds every number in the text, from digits ("1,200", "5k", "$500.50") or words. */
function extractNumbers(text: string): number[] {
  const found: number[] = [];
  const lower = text.toLowerCase();

  // digit numbers first; remove them so words are parsed from what remains
  const rest = lower.replace(/\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k\b|thousand\b)?/g, (_m, digits: string, mult?: string) => {
    const n = Number(digits.replace(/,/g, ""));
    if (Number.isFinite(n)) found.push(mult ? n * 1000 : n);
    return " | ";
  });

  const tokens = rest.replace(/[^a-z|\s-]/g, " ").replace(/-/g, " ").split(/\s+/).filter(Boolean);
  let run: string[] = [];
  const flush = () => {
    if (run.length > 0) {
      const v = parseWordRun(run.map((t) => (t === "a" ? "one" : t)));
      if (v !== null) found.push(v);
      run = [];
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (isNumberWord(t, tokens[i + 1])) run.push(t);
    else if (run.length > 0 && t === "and") continue; // "two thousand and five hundred" style
    else flush();
  }
  flush();
  return found;
}

export function parseVoiceCommand(transcript: unknown): VoiceCommand {
  if (typeof transcript !== "string" || transcript.length === 0 || transcript.length > 300) {
    return { kind: "unclear" };
  }
  const text = transcript.toLowerCase();
  // Require explicit intent: "limit" must be mentioned. Relative phrases are not supported.
  if (!/\blimit\b/.test(text)) return { kind: "unclear" };
  if (/\b(by|more|less|plus|minus|add|subtract|double|half|halve|triple)\b/.test(text)) return { kind: "unclear" };

  const numbers = extractNumbers(text);
  if (numbers.length !== 1) return { kind: "unclear" };
  const amount = numbers[0]!;
  try {
    return { kind: "set_limit", amount: validateLimit(amount) };
  } catch {
    return { kind: "out_of_range", amount: Math.min(amount, MAX_DAILY_LIMIT * 1000) };
  }
}
