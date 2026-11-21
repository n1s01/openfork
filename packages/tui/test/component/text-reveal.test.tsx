/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { ManualClock } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { createTextReveal } from "../../src/ui/animation"

// Mounts a reveal on a manual clock. `shown` reads what the reveal currently renders.
async function mount(input: { text?: string; live?: boolean; enabled?: boolean }) {
  const clock = new ManualClock()
  const [text, setText] = createSignal(input.text ?? "")
  const [live, setLive] = createSignal(input.live ?? true)
  const [enabled, setEnabled] = createSignal(input.enabled ?? true)
  let reveal: ReturnType<typeof createTextReveal> | undefined
  const app = await testRender(
    () => {
      reveal = createTextReveal(text, { live, enabled })
      return <text>{reveal.text()}</text>
    },
    { width: 80, height: 2, clock, maxFps: Number.POSITIVE_INFINITY },
  )
  const advance = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 5) {
      clock.advance(5)
      await app.renderer.idle()
    }
  }
  return {
    app,
    setText,
    setLive,
    setEnabled,
    advance,
    shown: () => reveal!.text(),
    revealing: () => reveal!.revealing(),
    /** Milliseconds until the whole text shows, in 5 ms frames, up to `limit`. */
    async settle(limit = 5_000) {
      for (let elapsed = 0; elapsed <= limit; elapsed += 5) {
        if (!reveal!.revealing()) return elapsed
        await advance(5)
      }
      throw new Error("reveal did not settle")
    },
  }
}

const CHUNK = "eight words arrive at once from the model "

test("history that is already there shows whole", async () => {
  const view = await mount({ text: "Earlier answer", live: false })
  expect(view.shown()).toBe("Earlier answer")
  expect(view.revealing()).toBe(false)
  view.app.renderer.destroy()
})

test("a streamed chunk types out character by character", async () => {
  const view = await mount({})
  view.setText(CHUNK)
  const seen = new Set<number>()
  for (let frame = 0; frame < 200 && view.revealing(); frame++) {
    await view.advance(5)
    seen.add(view.shown().length)
    expect(CHUNK.startsWith(view.shown())).toBe(true)
  }
  expect(view.shown()).toBe(CHUNK)
  // Many intermediate lengths, not one jump.
  expect(seen.size).toBeGreaterThan(5)
  view.app.renderer.destroy()
})

test("the typing pace follows how fast the model streams", async () => {
  const pace = async (interval: number) => {
    const view = await mount({})
    let text = ""
    for (let chunk = 0; chunk < 6; chunk++) {
      text += CHUNK
      view.setText(text)
      await view.advance(interval)
    }
    text += CHUNK
    view.setText(text)
    const elapsed = await view.settle()
    view.app.renderer.destroy()
    return elapsed
  }
  const fast = await pace(20)
  const slow = await pace(250)
  expect(slow).toBeGreaterThan(fast * 2)
})

test("the rest lands quickly once the stream ends", async () => {
  const view = await mount({})
  view.setText(CHUNK.repeat(20))
  await view.advance(10)
  expect(view.revealing()).toBe(true)
  view.setLive(false)
  expect(await view.settle()).toBeLessThanOrEqual(400)
  expect(view.shown()).toBe(CHUNK.repeat(20))
  view.app.renderer.destroy()
})

test("a change that is not an append shows at once", async () => {
  const view = await mount({ text: "", live: true })
  view.setText(CHUNK)
  await view.advance(10)
  view.setText("Replaced answer")
  expect(view.shown()).toBe("Replaced answer")
  expect(view.revealing()).toBe(false)
  view.app.renderer.destroy()
})

test("with animations off the text shows whole", async () => {
  const view = await mount({ enabled: false })
  view.setText(CHUNK)
  expect(view.shown()).toBe(CHUNK)
  expect(view.revealing()).toBe(false)
  view.app.renderer.destroy()
})
