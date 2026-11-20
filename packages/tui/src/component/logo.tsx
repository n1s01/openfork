import { RGBA, TextAttributes } from "@opentui/core"
import { createSignal, For, onCleanup, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { tint } from "../theme/color"
import { go, logo } from "../logo"
import { useConfig } from "../config"

// OpenFork: the logo sweeps in from the left once per mount.
const INTRO_DURATION = 700
const INTRO_FEATHER = 8
const INTRO_WIDTH = 40

function useIntro() {
  const config = useConfig().data
  const [progress, setProgress] = createSignal((config.animations ?? true) ? 0 : 1)
  if (progress() < 1) {
    const start = performance.now()
    const timer = setInterval(() => {
      const next = Math.min(1, (performance.now() - start) / INTRO_DURATION)
      setProgress(next)
      if (next >= 1) clearInterval(timer)
    }, 16)
    onCleanup(() => clearInterval(timer))
  }
  // 0..1 visibility of a column; eased so the front slows as it lands.
  return (column: number) => {
    const t = progress()
    if (t >= 1) return 1
    const eased = 1 - Math.pow(1 - t, 3)
    const front = -INTRO_FEATHER + eased * (INTRO_WIDTH + INTRO_FEATHER * 2)
    return Math.max(0, Math.min(1, (front - column) / INTRO_FEATHER))
  }
}

export function Logo() {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  const intro = useIntro()

  const renderLine = (line: string, base: RGBA, bold: boolean, offset = 0): JSX.Element[] => {
    const attrs = bold ? TextAttributes.BOLD : undefined
    return Array.from(line).map((char, column) => {
      const visible = intro(offset + column)
      const fg = visible >= 1 ? base : tint(theme.background.base, base, visible)
      const shadow = tint(theme.background.base, base, 0.25 * visible)
      if (char === "_") {
        return (
          <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>
            {" "}
          </text>
        )
      }
      if (char === "^") {
        return (
          <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>
            ▀
          </text>
        )
      }
      if (char === "~") {
        return (
          <text fg={shadow} attributes={attrs} selectable={false}>
            ▀
          </text>
        )
      }
      if (char === ",") {
        return (
          <text fg={shadow} attributes={attrs} selectable={false}>
            ▄
          </text>
        )
      }
      return (
        <text fg={fg} attributes={attrs} selectable={false}>
          {char}
        </text>
      )
    })
  }

  return (
    <box>
      {dimensions().height < 12 ? null : dimensions().width < 22 ? (
        <For each={go.right.slice(1)}>
          {(line) => <box flexDirection="row">{renderLine(line, theme.text.base, true)}</box>}
        </For>
      ) : dimensions().width < 44 ? (
        <>
          <For each={logo.left.slice(1)}>
            {(line) => <box flexDirection="row">{renderLine(line, theme.text.muted, false)}</box>}
          </For>
          <For each={logo.right}>
            {(line) => <box flexDirection="row">{renderLine(line, theme.text.base, true)}</box>}
          </For>
        </>
      ) : (
        <For each={logo.left}>
          {(line, index) => (
            <box flexDirection="row" gap={1}>
              <box flexDirection="row">{renderLine(line, theme.text.muted, false)}</box>
              <box flexDirection="row">{renderLine(logo.right[index()], theme.text.base, true, line.length + 1)}</box>
            </box>
          )}
        </For>
      )}
    </box>
  )
}
