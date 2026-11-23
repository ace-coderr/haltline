import { test } from "node:test";
import assert from "node:assert/strict";
import { GroqError, GROQ_MODEL, GROQ_URL, MAX_AUDIO_BYTES, normalizeAudioType, transcribe } from "./groq.ts";

const audio = new Uint8Array([1, 2, 3, 4]);
const ok = (text: string) => new Response(JSON.stringify({ text }), { status: 200 });

function run(responses: (Response | Error)[], extra: { apiKey?: string | undefined } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    if (r instanceof Error) throw r;
    return r.clone();
  }) as unknown as typeof fetch;
  const p = transcribe(audio, "audio/wav", {
    apiKey: "k" in extra ? undefined : (extra.apiKey ?? "gsk_test"),
    fetchFn,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { p, calls, sleeps };
}

test("sends the documented request and returns trimmed text", async () => {
  const { p, calls } = run([ok("  Set limit five hundred.  ")]);
  assert.equal(await p, "Set limit five hundred.");
  const c = calls[0]!;
  assert.equal(c.url, GROQ_URL);
  assert.equal((c.init.headers as Record<string, string>).Authorization, "Bearer gsk_test");
  const form = c.init.body as FormData;
  assert.equal(form.get("model"), GROQ_MODEL);
  assert.equal(form.get("response_format"), "json");
  assert.equal(form.get("language"), "en");
  assert.ok(form.get("file") instanceof Blob);
});

test("missing key, bad type, empty and oversized audio are rejected before any request", async () => {
  const never = (async () => {
    throw new Error("must not be called");
  }) as unknown as typeof fetch;
  const t = (a: Uint8Array, type: string, withKey = true) =>
    transcribe(a, type, { apiKey: withKey ? "gsk_x" : undefined, fetchFn: never });
  await assert.rejects(t(audio, "audio/wav", false), (e: unknown) => e instanceof GroqError && e.kind === "not_configured");
  await assert.rejects(t(audio, "text/plain"), (e: unknown) => e instanceof GroqError && e.kind === "bad_audio");
  await assert.rejects(t(new Uint8Array(0), "audio/wav"), (e: unknown) => e instanceof GroqError && e.kind === "bad_audio");
  await assert.rejects(t(new Uint8Array(MAX_AUDIO_BYTES + 1), "audio/wav"), (e: unknown) => e instanceof GroqError && e.kind === "bad_audio");
});

test("429 with a short retry-after waits once and succeeds", async () => {
  const { p, sleeps, calls } = run([new Response("", { status: 429, headers: { "retry-after": "2" } }), ok("hi")]);
  assert.equal(await p, "hi");
  assert.deepEqual(sleeps, [2000]);
  assert.equal(calls.length, 2);
});

test("429 with a long retry-after fails fast with the wait time for the UI", async () => {
  const { p, calls } = run([new Response("", { status: 429, headers: { "retry-after": "30" } })]);
  await assert.rejects(p, (e: unknown) => e instanceof GroqError && e.kind === "rate_limited" && e.retryAfterSeconds === 30);
  assert.equal(calls.length, 1);
});

test("5xx and network errors are retried then reported as unavailable", async () => {
  const a = run([new Response("", { status: 503 })]);
  await assert.rejects(a.p, (e: unknown) => e instanceof GroqError && e.kind === "unavailable");
  assert.equal(a.calls.length, 3);
  const b = run([new TypeError("offline")]);
  await assert.rejects(b.p, (e: unknown) => e instanceof GroqError && e.kind === "unavailable");
  assert.equal(b.calls.length, 3);
  const c = run([new Response("", { status: 502 }), ok("recovered")]);
  assert.equal(await c.p, "recovered");
});

test("auth and bad-request errors are not retried", async () => {
  const a = run([new Response("", { status: 401 })]);
  await assert.rejects(a.p, (e: unknown) => e instanceof GroqError && e.kind === "auth");
  assert.equal(a.calls.length, 1);
  const b = run([new Response("", { status: 400 })]);
  await assert.rejects(b.p, (e: unknown) => e instanceof GroqError && e.kind === "bad_audio");
});

test("unreadable or textless success responses are failures", async () => {
  await assert.rejects(run([new Response("<html>", { status: 200 })]).p, (e: unknown) => e instanceof GroqError && e.kind === "unavailable");
  await assert.rejects(run([new Response("{}", { status: 200 })]).p, (e: unknown) => e instanceof GroqError && e.kind === "unavailable");
});

test("normalizeAudioType strips parameters and rejects unknown types", () => {
  assert.equal(normalizeAudioType("audio/webm;codecs=opus"), "audio/webm");
  assert.equal(normalizeAudioType("AUDIO/WAV"), "audio/wav");
  assert.equal(normalizeAudioType("application/octet-stream"), null);
  assert.equal(normalizeAudioType(null), null);
});
