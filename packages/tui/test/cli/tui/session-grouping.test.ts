import { expect, test } from "bun:test"
import { append, groupRefs, partitionPending, partPath, projectEntries, type SessionRow } from "../../../src/routes/session/grouping/session"

test("a pending tool does not hide a later tool reusing its call ID in another message", () => {
  const rows: SessionRow[] = []
  const blocked = { messageID: "assistant-a", partID: "call-reused" }
  const later = { messageID: "assistant-b", partID: "call-reused" }
  append(rows, blocked, { type: "tool", name: "read" }, rows.length, "medium")
  partitionPending(rows, new Set([blocked.partID]))
  append(rows, later, { type: "tool", name: "read" }, rows.length, "medium")

  const group = rows[0]
  if (group.type !== "group" || group.kind !== "exploration") throw new Error("Expected exploration group")
  expect(groupRefs(group)).toEqual([later])
  expect(group.pending).toEqual([blocked])
  expect(groupRefs(group, true)).toEqual([later, blocked])

  partitionPending(rows, new Set())
  expect(groupRefs(group)).toEqual([later, blocked])
  expect(group.pending).toEqual([])
})

test("live appends extend the open subgroup in place and match a batch projection", () => {
  const parts = [
    [{ messageID: "a", partID: "reasoning:0" }, { type: "reasoning" }],
    [{ messageID: "a", partID: "r1" }, { type: "tool", name: "read" }],
    [{ messageID: "a", partID: "r2" }, { type: "tool", name: "grep" }],
    [{ messageID: "b", partID: "r3" }, { type: "tool", name: "read" }],
  ] as const
  const rows: SessionRow[] = []
  append(rows, parts[0][0], parts[0][1], rows.length, "low")
  append(rows, parts[1][0], parts[1][1], rows.length, "low")
  const activity = rows[0]
  if (activity.type !== "group") throw new Error("Expected activity group")
  const exploration = activity.children[1]
  append(rows, parts[2][0], parts[2][1], rows.length, "low")
  append(rows, parts[3][0], parts[3][1], rows.length, "low")

  // Keyed renderers match by reference: the subgroup a part joins must not be replaced.
  expect(rows[0]).toBe(activity)
  expect(activity.children[1]).toBe(exploration)
  expect(activity.size).toBe(4)
  expect(exploration).toMatchObject({ type: "group", kind: "exploration", size: 3 })
  expect(groupRefs(activity)).toEqual(parts.map(([ref]) => ref))

  const batch = projectEntries(parts.map(([ref, part]) => ({ entry: { type: "part", ref }, part, path: partPath(part, "low") })))
  expect(batch).toHaveLength(1)
  expect(batch[0]).toMatchObject({ type: "group", kind: "activity", size: 4 })
  expect(rows[0].type === "group" && rows[0].children).toEqual(batch[0].type === "group" && batch[0].children)
})
