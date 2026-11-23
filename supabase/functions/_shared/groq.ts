// Groq Whisper transcription (free tier: about 20 requests/min, 2,000/day, no SLA).
// Endpoint, model ids, form fields, 25 MB free-tier file limit and the retry-after header
// follow the Groq speech-to-text and rate-limit docs read on 2026-11-23.
// Failures are surfaced as typed errors so the glasses can show a visible failure state
// and fall back to gestures.

export type GroqErrorKind = "not_configured" | "bad_audio" | "rate_limited" | "auth" | "unavailable";

export class GroqError extends Error {
  readonly kind: GroqErrorKind;
  readonly retryAfterSeconds: number | null;
  constructor(kind: GroqErrorKind, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "GroqError";
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
export const GROQ_MODEL = "whisper-large-v3-turbo";
/** Voice limit commands are a couple of seconds long; refuse anything large. */
export const MAX_AUDIO_BYTES = 1_000_000;
export const ALLOWED_AUDIO_TYPES = ["audio/wav", "audio/x-wav", "audio/wave", "audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/m4a", "audio/flac"] as const;

const EXTENSION: Record<string, string> = {
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/webm": "webm", "audio/ogg": "ogg",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/flac": "flac",
};

export interface TranscribeOptions {
  apiKey: string | undefined;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Longest single wait we are willing to honour from retry-after. */
  maxWaitMs?: number;
  timeoutMs?: number;
}

export function normalizeAudioType(contentType: string | null): string | null {
  const base = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return (ALLOWED_AUDIO_TYPES as readonly string[]).includes(base) ? base : null;
}

export async function transcribe(audio: Uint8Array, contentType: string, opts: TranscribeOptions): Promise<string> {
  if (!opts.apiKey) throw new GroqError("not_configured", "voice is not configured");
  const type = normalizeAudioType(contentType);
  if (!type) throw new GroqError("bad_audio", "unsupported audio type");
  if (audio.byteLength === 0) throw new GroqError("bad_audio", "empty audio");
  if (audio.byteLength > MAX_AUDIO_BYTES) throw new GroqError("bad_audio", "audio is too large");

  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxWaitMs = opts.maxWaitMs ?? 3000;

  let lastError: GroqError = new GroqError("unavailable", "transcription unavailable");
  for (let attempt = 0; attempt < 3; attempt++) {
    const form = new FormData();
    form.append("file", new Blob([audio as BlobPart], { type }), `speech.${EXTENSION[type]}`);
    form.append("model", GROQ_MODEL);
    form.append("language", "en");
    form.append("response_format", "json");
    form.append("temperature", "0");
    form.append("prompt", "Set limit to five hundred dollars.");

    let res: Response;
    try {
      res = await fetchFn(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
    } catch {
      lastError = new GroqError("unavailable", "could not reach the transcription service");
      if (attempt < 2) await sleep(300 * 2 ** attempt);
      continue;
    }

    if (res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new GroqError("unavailable", "transcription returned an unreadable response");
      }
      const text = (body as { text?: unknown } | null)?.text;
      if (typeof text !== "string") throw new GroqError("unavailable", "transcription returned no text");
      return text.trim();
    }

    if (res.status === 401 || res.status === 403) throw new GroqError("auth", "transcription key was rejected");
    if (res.status === 400 || res.status === 413 || res.status === 422) throw new GroqError("bad_audio", "audio was rejected");
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
      lastError = new GroqError("rate_limited", "transcription is rate limited", seconds);
      // only wait if the server says it is short; otherwise surface the failure state now
      if (seconds !== null && seconds * 1000 <= maxWaitMs && attempt < 2) {
        await sleep(seconds * 1000);
        continue;
      }
      throw lastError;
    }
    lastError = new GroqError("unavailable", `transcription service error (HTTP ${res.status})`);
    if (attempt < 2) await sleep(300 * 2 ** attempt);
  }
  throw lastError;
}
