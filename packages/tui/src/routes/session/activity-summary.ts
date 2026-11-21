import type {
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode/client"
import { canonicalToolName, executeCalls } from "../../util/tool-display"
import { visitEntries } from "./anchor-view"
import { instructionPaths, type PartRef, type SessionEntry, type SessionNode } from "./grouping/session"
import { reasoningContent } from "./message-parts"
import { resolvePart } from "./rows"

type Item = {
  message: SessionMessageAssistant
  part: SessionMessageAssistantReasoning | SessionMessageAssistantTool
}

/** Summary for an activity group's subtree; permission-blocked tools are left out. */
export function summarizeActivity(
  node: Extract<SessionNode, { type: "group" }>,
  message: (messageID: string) => SessionMessageInfo | undefined,
  pending: readonly PartRef[],
  closed: boolean,
) {
  const entries: SessionEntry[] = []
  visitEntries(node.children, (entry) => entries.push(entry))
  const items = entries.flatMap((entry) => {
    if (entry.type !== "part") return []
    if (pending.some((ref) => ref.messageID === entry.ref.messageID && ref.partID === entry.ref.partID)) return []
    const item = message(entry.ref.messageID)
    if (item?.type !== "assistant") return []
    const part = resolvePart(item, entry.ref.partID)
    return part?.type === "reasoning" || part?.type === "tool" ? [{ entry, message: item, part }] : []
  })
  const files = new Set(
    entries.flatMap((entry) => (entry.type === "message" ? instructionPaths(message(entry.messageID)) : [])),
  )
  return activitySummary(items, files.size, closed)
}

type Noun = "command" | "edit" | "read" | "tool"

/**
 * Low verbosity's activity summary: everything in the group, then what is still in flight, e.g.
 * "2 commands, 1 edit, 4 reads · 1 command running". Tools the model is still writing are "preparing",
 * and an open thought is "thinking"; it counts as a thought once it finishes.
 * Code-mode `execute` counts its nested calls rather than itself, unless it has none yet.
 * Instructions count distinct loaded files, matching the instruction subgroup.
 * Once a later row closes the group, its thoughts count as finished, as in Medium.
 */
export function activitySummary(items: readonly Item[], instructions: number, closed = false) {
  const counts = { command: 0, edit: 0, thought: 0, read: 0, tool: 0, instruction: instructions }
  const running: Record<Noun, number> = { command: 0, edit: 0, read: 0, tool: 0 }
  const preparing: Record<Noun, number> = { command: 0, edit: 0, read: 0, tool: 0 }
  let code = false
  let thinking = false
  items.forEach((item) => {
    if (item.part.type === "reasoning") {
      if (isActive(item, closed)) thinking = true
      // Redacted-only reasoning renders nothing, so it isn't a visible thought.
      else if (reasoningContent(item.part)) counts.thought++
      return
    }
    const name = canonicalToolName(item.part.name)
    const active = isActive(item, closed)
    if (name === "execute") {
      const calls = executeCalls(
        item.part.state.status === "streaming" ? undefined : item.part.state.metadata?.toolCalls,
      )
      calls.forEach((call) => {
        const noun = canonicalToolName(call.tool) === "read" ? "read" : "tool"
        counts[noun]++
        if (active && call.status === "running") running[noun]++
      })
      // With no nested calls to count, execute counts as itself.
      if (calls.length === 0) counts.tool++
      if (active && !calls.some((call) => call.status === "running")) code = true
      return
    }
    const noun = toolNoun(name)
    counts[noun]++
    if (!active) return
    if (item.part.state.status === "streaming") preparing[noun]++
    else running[noun]++
  })
  const flight = [
    nouns(running) && `${nouns(running)} running`,
    nouns(preparing) && `${nouns(preparing)} preparing`,
    code && "code running",
    thinking && "thinking",
  ].filter(Boolean)
  const total = nouns(counts)
  return {
    label: [total, flight.join(", ")].filter(Boolean).join(" · "),
    active: items.some((item) => isActive(item, closed)),
  }
}

function toolNoun(name: string): Noun {
  if (name === "shell") return "command"
  if (name === "read") return "read"
  if (name === "edit" || name === "write" || name === "patch") return "edit"
  return "tool"
}

/** "2 commands, 1 read" for the non-zero counts, in their declaration order. */
function nouns(counts: Readonly<Record<string, number>>) {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${count} ${name}${count === 1 ? "" : "s"}`)
    .join(", ")
}

function isActive(item: Item, closed: boolean) {
  if (item.part.type === "reasoning")
    return !closed && item.part.time?.completed === undefined && item.message.time.completed === undefined
  return item.part.state.status === "streaming" || item.part.state.status === "running"
}
