// Packs raw microphone PCM into a WAV file. The glasses deliver signed 16-bit little-endian
// mono PCM at 16 kHz (100 ms per event, per the simulator's documented audio spec; the format
// on real hardware is not verified).

export const SAMPLE_RATE = 16_000
export const BYTES_PER_SAMPLE = 2

export function pcmDurationMs(byteLength: number): number {
  return Math.round((byteLength / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000)
}

export function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

export function pcmToWav(pcm: Uint8Array, sampleRate: number = SAMPLE_RATE): Uint8Array {
  const dataLen = pcm.byteLength - (pcm.byteLength % BYTES_PER_SAMPLE) // whole samples only
  const out = new Uint8Array(44 + dataLen)
  const v = new DataView(out.buffer)
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + dataLen, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true) // PCM chunk size
  v.setUint16(20, 1, true) // PCM format
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true) // byte rate
  v.setUint16(32, BYTES_PER_SAMPLE, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  v.setUint32(40, dataLen, true)
  out.set(pcm.subarray(0, dataLen), 44)
  return out
}
