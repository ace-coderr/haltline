// Draws the giant text into two 288x144 PNGs (the largest image the glasses accept), which
// sit side by side to form a 576x144 strip. White on black: the host converts to 4-bit gray
// and the display shows it in phosphor green. Browser-only.

export const HALF_W = 288
export const BIG_H = 144
const FULL_W = HALF_W * 2

const cache = new Map<string, { left: number[]; right: number[] }>()

function toBytes(c: HTMLCanvasElement): Promise<number[]> {
  return new Promise((resolve, reject) => {
    c.toBlob(async (b) => {
      if (!b) return reject(new Error('png encode failed'))
      resolve(Array.from(new Uint8Array(await b.arrayBuffer())))
    }, 'image/png')
  })
}

export async function renderBig(text: string): Promise<{ left: number[]; right: number[] }> {
  const hit = cache.get(text)
  if (hit) return hit
  const full = document.createElement('canvas')
  full.width = FULL_W
  full.height = BIG_H
  const g = full.getContext('2d')!
  g.fillStyle = '#000'
  g.fillRect(0, 0, FULL_W, BIG_H)
  g.fillStyle = '#fff'
  g.textAlign = 'center'
  g.textBaseline = 'alphabetic'
  const family = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif'
  let size = 132
  g.font = `bold ${size}px ${family}`
  const maxW = FULL_W - 48 // at least 24 px of margin on each side
  const w = g.measureText(text).width
  if (w > maxW) {
    size = Math.max(24, Math.floor((size * maxW) / w))
    g.font = `bold ${size}px ${family}`
  }
  const m = g.measureText('0')
  const capH = m.actualBoundingBoxAscent || size * 0.72
  g.fillText(text, FULL_W / 2, Math.round(BIG_H / 2 + capH / 2))

  const half = (x: number): HTMLCanvasElement => {
    const c = document.createElement('canvas')
    c.width = HALF_W
    c.height = BIG_H
    c.getContext('2d')!.drawImage(full, x, 0, HALF_W, BIG_H, 0, 0, HALF_W, BIG_H)
    return c
  }
  const out = { left: await toBytes(half(0)), right: await toBytes(half(HALF_W)) }
  if (cache.size > 24) cache.clear()
  cache.set(text, out)
  return out
}
