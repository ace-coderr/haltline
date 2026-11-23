// Draws a Screen onto the glasses. One fixed layout, six containers:
//   status (text) / giant text (two images side by side) / gauge (text) / sub (text) / hint (text)
// Only the pieces that changed are sent, and all bridge writes are serialised and coalesced:
// if the model changes three times while a write is in flight, only the latest state is sent.
// Text updates are a few dozen bytes; images are re-sent only when the giant text changes.

import {
  CreateStartUpPageContainer, type EvenAppBridge, ImageContainerProperty, ImageRawDataUpdate, RebuildPageContainer,
  TextContainerProperty, TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { BIG_H, HALF_W, renderBig } from './canvas.ts'

const ID = { status: 1, imgL: 2, imgR: 3, gauge: 4, sub: 5, hint: 6 } as const
const NAME = { status: 'status', imgL: 'big_l', imgR: 'big_r', gauge: 'gauge', sub: 'sub', hint: 'hint' } as const

export interface Frame {
  status: string
  big: string
  gauge: string
  sub: string
  hint: string
}

/** Safe margin on the left and right of every text line, in px. */
const MARGIN = 10
/** The gauge is 27 cells x 20 px = 540 px wide, centred: 18 px margin each side. */
const GAUGE_W = 540
const GAUGE_X = (576 - GAUGE_W) / 2

const nonEmpty = (s: string): string => (s.length > 0 ? s : ' ')

export class Renderer {
  private readonly bridge: EvenAppBridge
  private shown: Frame | null = null
  private want: Frame | null = null
  private flushing = false
  private ready = false

  constructor(bridge: EvenAppBridge) {
    this.bridge = bridge
  }

  async init(first: Frame): Promise<boolean> {
    const text = (id: number, name: string, y: number, h: number, content: string, capture = 0, x = MARGIN, w = 576 - 2 * MARGIN) =>
      new TextContainerProperty({
        xPosition: x, yPosition: y, width: w, height: h, borderWidth: 0, borderColor: 0, paddingLength: 0,
        containerID: id, containerName: name, content: nonEmpty(content), isEventCapture: capture,
      })
    const img = (id: number, name: string, x: number) =>
      new ImageContainerProperty({ xPosition: x, yPosition: 34, width: HALF_W, height: BIG_H, containerID: id, containerName: name })

    const layout = {
      containerTotalNum: 6,
      textObject: [
        text(ID.status, NAME.status, 0, 34, first.status),
        text(ID.gauge, NAME.gauge, 178, 34, first.gauge, 0, GAUGE_X, GAUGE_W),
        text(ID.sub, NAME.sub, 212, 38, first.sub),
        text(ID.hint, NAME.hint, 250, 38, first.hint, 1),
      ],
      imageObject: [img(ID.imgL, NAME.imgL, 0), img(ID.imgR, NAME.imgR, HALF_W)],
    }
    // createStartUpPageContainer works once per session; if the page was reloaded (or the
    // app restarted inside a running session) fall back to rebuilding the page instead.
    const result = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(layout))
    this.ready = result === 0 || (await this.bridge.rebuildPageContainer(new RebuildPageContainer(layout)))
    if (!this.ready) {
      console.error('createStartUpPageContainer failed', result)
      return false
    }
    // text is already on screen; the images still need their first picture
    this.shown = { ...first, big: '\u0000' }
    this.draw(first)
    return true
  }

  /** Requests a frame. Cheap to call often; only differences are transmitted. */
  draw(frame: Frame): void {
    this.want = frame
    if (this.ready && !this.flushing) void this.flush()
  }

  private async setText(field: 'status' | 'gauge' | 'sub' | 'hint', content: string): Promise<void> {
    await this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: ID[field], containerName: NAME[field], content: nonEmpty(content) }),
    )
  }

  private async flush(): Promise<void> {
    this.flushing = true
    try {
      while (this.want && this.shown && !sameFrame(this.want, this.shown)) {
        const want = this.want
        const shown = this.shown
        // texts first: they are cheap and keep the display responsive while an image is in flight
        for (const f of ['status', 'gauge', 'sub', 'hint'] as const) {
          if (want[f] !== shown[f]) {
            await this.setText(f, want[f])
            shown[f] = want[f]
          }
        }
        if (want.big !== shown.big) {
          const { left, right } = await renderBig(want.big)
          await this.bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: ID.imgL, containerName: NAME.imgL, imageData: left }))
          await this.bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: ID.imgR, containerName: NAME.imgR, imageData: right }))
          shown.big = want.big
        }
      }
    } catch (e) {
      console.error('render failed', e instanceof Error ? e.message : String(e))
      // force a full resend next time rather than trusting what is on the glasses
      this.shown = this.shown ? { status: '\u0000', gauge: '\u0000', sub: '\u0000', hint: '\u0000', big: '\u0000' } : null
    } finally {
      this.flushing = false
    }
  }
}

function sameFrame(a: Frame, b: Frame): boolean {
  return a.status === b.status && a.big === b.big && a.gauge === b.gauge && a.sub === b.sub && a.hint === b.hint
}
