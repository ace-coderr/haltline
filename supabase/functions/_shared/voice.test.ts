import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVoiceCommand } from "./voice.ts";

const set = (amount: number) => ({ kind: "set_limit", amount });
const unclear = { kind: "unclear" };

test("the example from the brief", () => {
  assert.deepEqual(parseVoiceCommand("set limit five hundred"), set(500));
});

test("digit forms from Whisper-style transcripts", () => {
  assert.deepEqual(parseVoiceCommand("Set limit to $500."), set(500));
  assert.deepEqual(parseVoiceCommand("Set limit to 500 dollars"), set(500));
  assert.deepEqual(parseVoiceCommand("set the limit to 1,200"), set(1200));
  assert.deepEqual(parseVoiceCommand("Set limit 2.5k"), set(2500));
  assert.deepEqual(parseVoiceCommand("set limit 5 thousand"), set(5000));
  assert.deepEqual(parseVoiceCommand("Set limit to 750.50"), set(750.5));
});

test("word forms", () => {
  assert.deepEqual(parseVoiceCommand("set limit to two thousand five hundred dollars"), set(2500));
  assert.deepEqual(parseVoiceCommand("set limit twelve hundred"), set(1200));
  assert.deepEqual(parseVoiceCommand("set limit fifteen hundred"), set(1500));
  assert.deepEqual(parseVoiceCommand("set limit to a thousand"), set(1000));
  assert.deepEqual(parseVoiceCommand("Set limit to twenty-five"), set(25));
  assert.deepEqual(parseVoiceCommand("set limit one hundred and fifty"), set(150));
  assert.deepEqual(parseVoiceCommand("make the limit three hundred bucks"), set(300));
  assert.deepEqual(parseVoiceCommand("set limit to one million"), set(1_000_000));
});

test("out-of-range amounts are reported, never accepted", () => {
  assert.equal(parseVoiceCommand("set limit to 0").kind, "out_of_range");
  assert.equal(parseVoiceCommand("set limit to two million").kind, "out_of_range");
  assert.equal(parseVoiceCommand("set limit to 0.5").kind, "out_of_range");
});

test("no intent, no number, or several numbers means unclear", () => {
  assert.deepEqual(parseVoiceCommand("five hundred"), unclear);
  assert.deepEqual(parseVoiceCommand("set limit"), unclear);
  assert.deepEqual(parseVoiceCommand("set limit five hundred no seven hundred"), unclear);
  assert.deepEqual(parseVoiceCommand("hello there"), unclear);
  assert.deepEqual(parseVoiceCommand(""), unclear);
});

test("relative phrasing is not guessed", () => {
  assert.deepEqual(parseVoiceCommand("raise limit by one hundred"), unclear);
  assert.deepEqual(parseVoiceCommand("double the limit"), unclear);
  assert.deepEqual(parseVoiceCommand("increase limit by 50"), unclear);
});

test("non-string and oversized input is unclear", () => {
  for (const bad of [null, undefined, 500, {}, [], "x".repeat(301)]) assert.deepEqual(parseVoiceCommand(bad), unclear);
});
