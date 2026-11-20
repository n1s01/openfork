import { expect, test } from "bun:test"
import { type Renderable, ScrollBoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"
import { waitForHighlightedFrame } from "./fixture/frame"

test("message navigation walks past the mounted tail without mounting the whole transcript", async () => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
  await setup.renderer.setupTerminal()
  setup.renderer.start()
  const session = {
    id: "ses_test",
    title: "Long history",
    projectID: "project",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const messages = Array.from({ length: 400 }, (_, index) => ({
    id: `message-${index}`,
    type: "user",
    text: `History message ${String(index).padStart(4, "0")}`,
    time: { created: index },
  }))
  const events = createEventStream()
  const calls = createFetch(async (url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === "/api/session/ses_test") return json({ data: session })
    // The whole history arrives in one page, so navigation never needs to load more.
    if (url.pathname === "/api/session/ses_test/message") return json({ data: messages.toReversed(), cursor: {} })
    if (url.pathname === "/api/session/ses_test/inbox") return json({ data: [] })
    if (url.pathname === "/api/session/ses_test/permission") return json({ data: [] })
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })

  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => ({
          animations: false,
          tabs: { mode: "off" },
          keybinds: { "session.message.previous": "f9" },
        }),
        update: async () => ({}),
      },
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      args: { sessionID: "ses_test" },
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  try {
    await waitForHighlightedFrame(setup, (frame) => frame.includes("History message 0399"))
    const findScrollBox = (root: Renderable): ScrollBoxRenderable | undefined =>
      root instanceof ScrollBoxRenderable && root.getRenderable("message-399")
        ? root
        : root.getChildren().map(findScrollBox).find(Boolean)
    const scroll = findScrollBox(setup.renderer.root)
    if (!scroll) throw new Error("session transcript scrollbox was not found")
    const mounted = () => scroll.getChildren().filter((child) => child.id?.startsWith("message-")).length
    const top = (frame: string) => Number(frame.match(/History message (\d{4})/)?.[1] ?? Infinity)
    await setup.waitForVisualIdle()
    expect(mounted()).toBe(40)

    // The first press aligns the partly visible top message, so it need not change the top row.
    setup.mockInput.pressKey("F9")
    await setup.waitForVisualIdle()

    // More presses than the 40-row tail holds, so navigation has to widen the window.
    let previous = top(setup.captureCharFrame())
    let peak = mounted()
    for (const _ of Array.from({ length: 50 })) {
      setup.mockInput.pressKey("F9")
      await setup.waitForFrame((frame) => top(frame) < previous)
      previous = top(setup.captureCharFrame())
      peak = Math.max(peak, mounted())
    }

    expect(previous).toBeLessThan(360)
    // The tail plus the backfill chunks navigation needed, not all 400 rows.
    expect(peak).toBeLessThanOrEqual(160)
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 30_000)
