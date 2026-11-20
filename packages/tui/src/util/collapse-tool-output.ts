import { Locale } from "./locale"
import { stringWidth } from "./string-width"

// Running shells re-collapse up to 1 MB of output on every poll, so these helpers find line
// boundaries with indexOf and count code points only when the UTF-16 length cannot decide.
export function collapseToolOutput(output: string, maxLines: number, maxChars: number) {
  const cut = lineEnd(output, maxLines)
  if (cut === -1 && withinChars(output, maxChars)) {
    return { output, overflow: false }
  }

  const preview = cut === -1 ? output : maxLines > 0 ? output.slice(0, cut) + "…" : ""
  if (!withinChars(preview, maxChars)) {
    return {
      output:
        Array.from(preview)
          .slice(0, Math.max(0, maxChars - 1))
          .join("") + "…",
      overflow: true,
    }
  }

  return { output: preview, overflow: true }
}

export function collapseShellOutput(input: string, output: string, maxLines: number, maxChars: number) {
  if (!input) {
    const collapsed = collapseToolOutput(output, maxLines, maxChars)
    return {
      input,
      output: collapsed.overflow ? collapseTail(output, maxLines, maxChars) : output,
      overflow: collapsed.overflow,
    }
  }

  const commandLines = Math.min(2, maxLines)
  const lineChars = Math.max(1, Math.floor(maxChars / Math.max(1, maxLines)))
  const command = collapseShellCommand(input, commandLines, lineChars)
  if (!output) return { input: command.output, output, overflow: command.overflow }

  const lines = Math.max(1, maxLines - command.lines - 1)
  const chars = Math.max(1, maxChars - Array.from(command.output).length - 2)
  const collapsed = collapseToolOutput(output, lines, chars)
  return {
    input: command.output,
    output: collapsed.overflow ? collapseTail(output, lines, chars) : output,
    overflow: command.overflow || collapsed.overflow,
  }
}

function collapseShellCommand(input: string, maxLines: number, lineWidth: number) {
  const visible: string[] = []
  let lines = 1
  let width = 0
  const overflow = Locale.graphemes(input).some((segment) => {
    if (segment === "\n") {
      if (lines >= maxLines) return true
      visible.push(segment)
      lines++
      width = 0
      return false
    }

    const next = stringWidth(segment)
    if (width + next > lineWidth) {
      if (lines >= maxLines) return true
      lines++
      width = 0
    }
    visible.push(segment)
    width += next
    return false
  })
  if (!overflow) return { output: input, overflow, lines }

  if (width >= lineWidth) {
    const removed = visible.pop()
    if (removed !== undefined && removed !== "\n") width -= stringWidth(removed)
  }
  return { output: visible.join("") + "…", overflow, lines }
}

function collapseTail(output: string, maxLines: number, maxChars: number) {
  const lines = lineCount(output)
  if (lines <= maxLines && withinChars(output, maxChars)) return output

  const count = Math.max(1, lines - Math.max(0, maxLines - 1))
  const label = `(${count} earlier ${count === 1 ? "line" : "lines"})`
  if (maxLines <= 1) return label

  const available = maxChars - Array.from(label).length - 1
  if (available <= 0) return label
  const preview = output.slice(tailStart(output, maxLines - 1))
  // Only the last `available` code points are shown; at most two UTF-16 units each.
  return `${label}\n${Array.from(preview.slice(-available * 2))
    .slice(-available)
    .join("")}`
}

/** Index of the newline ending line `count`, or -1 when the text has at most `count` lines. */
function lineEnd(text: string, count: number) {
  if (count <= 0) return 0
  let index = -1
  for (let line = 0; line < count; line++) {
    index = text.indexOf("\n", index + 1)
    if (index === -1) return -1
  }
  return index
}

function lineCount(text: string) {
  let count = 1
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++
  return count
}

/** Start of the last `count` lines. */
function tailStart(text: string, count: number) {
  let index = text.length
  for (let line = 0; line < count; line++) {
    if (index === 0) return 0
    index = text.lastIndexOf("\n", index - 1)
    if (index === -1) return 0
  }
  return index + 1
}

function withinChars(text: string, max: number) {
  if (text.length <= max) return true
  if (text.length > max * 2) return false
  return Array.from(text).length <= max
}
