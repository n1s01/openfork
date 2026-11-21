import type { CliRenderer } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"

type AnimatableValue = number | readonly number[]
type AnimatableTarget = Record<string, AnimatableValue>
type Ease = (progress: number) => number

type SpringTransition = {
  type: "spring"
  visualDuration: number
  restDelta: number
  restSpeed: number
}

type TweenTransition = {
  type: "tween"
  duration: number
  ease: Ease
}

type Transition = SpringTransition | TweenTransition

type ValueState = {
  scalar: boolean
  value: number[]
  target: number[]
  velocity: number[]
  from: number[]
}

type AnimationTask = (now: number) => boolean

// One 60 fps subscription on each renderer's shared animation clock while any of its tasks runs. Tasks belong to no
// node, so a hidden view's tween runs to its end; it stops early only when its owner is disposed.
const clocks = new Map<CliRenderer, { tasks: Set<AnimationTask>; stop: () => void }>()

const smoothstep = (progress: number) => progress * progress * (3 - 2 * progress)

export function spring(options: { visualDuration: number; restDelta?: number; restSpeed?: number }): Transition {
  return {
    type: "spring",
    visualDuration: options.visualDuration,
    restDelta: options.restDelta ?? 0.002,
    restSpeed: options.restSpeed ?? 0.002,
  }
}

export function tween(options: { duration: number; ease?: Ease }): Transition {
  return {
    type: "tween",
    duration: options.duration,
    ease: options.ease ?? smoothstep,
  }
}

export function createAnimatable<T extends AnimatableTarget>(
  initial: T,
  options: {
    transition: Transition
    enabled?: Accessor<boolean>
  },
) {
  const renderer = useRenderer()
  const enabled = options.enabled ?? (() => true)
  const state = new Map<string, ValueState>()
  const [value, setValue] = createSignal(clone(initial), { equals: false })
  let target = clone(initial)
  let started = renderer.clock.now()
  let previous = started

  rebuild(initial)

  const step: AnimationTask = (now) => {
    if (!enabled()) {
      jump(target)
      return false
    }

    const delta = Math.min(0.05, (now - previous) / 1_000)
    previous = now
    const moving = options.transition.type === "spring" ? advanceSpring(delta) : advanceTween(now)
    if (!moving) {
      jump(target)
      return false
    }
    setValue(() => read())
    return true
  }

  function animate(next: T) {
    if (sameTarget(next)) return
    target = clone(next)
    if (!enabled() || !sameShape(next)) return jump(next)

    started = renderer.clock.now()
    previous = started
    for (const [key, current] of state) {
      current.from = [...current.value]
      current.target = values(next[key]!)
    }
    if (settled()) return jump(next)
    schedule(renderer, step)
  }

  function jump(next: T) {
    target = clone(next)
    unschedule(renderer, step)
    rebuild(next)
    setValue(() => clone(next))
  }

  function stop() {
    unschedule(renderer, step)
  }

  function rebuild(next: T) {
    state.clear()
    for (const [key, nextValue] of Object.entries(next)) {
      const value = values(nextValue)
      state.set(key, {
        scalar: typeof nextValue === "number",
        value,
        target: [...value],
        velocity: value.map(() => 0),
        from: [...value],
      })
    }
    started = renderer.clock.now()
    previous = started
  }

  function sameShape(next: T) {
    const entries = Object.entries(next)
    if (entries.length !== state.size) return false
    return entries.every(([key, nextValue]) => {
      const current = state.get(key)
      if (!current || current.scalar !== (typeof nextValue === "number")) return false
      return current.value.length === values(nextValue).length
    })
  }

  function sameTarget(next: T) {
    if (!sameShape(next)) return false
    return Object.entries(next).every(([key, value]) =>
      values(value).every((part, index) => part === state.get(key)!.target[index]),
    )
  }

  function settled() {
    return [...state.values()].every(
      (current) =>
        current.value.every((value, index) => value === current.target[index]) &&
        current.velocity.every((velocity) => velocity === 0),
    )
  }

  function advanceSpring(delta: number) {
    const transition = options.transition
    if (transition.type !== "spring") return false
    const frequency = (2 * Math.PI) / (Math.max(0.001, transition.visualDuration) * 1.2)
    let moving = false

    for (const current of state.values()) {
      current.value.forEach((value, index) => {
        const target = current.target[index]!
        const velocity = current.velocity[index]!
        const offset = value - target
        const decay = Math.exp(-frequency * delta)
        const nextVelocity = velocity + frequency * offset
        current.value[index] = target + (offset + nextVelocity * delta) * decay
        current.velocity[index] = (velocity - frequency * nextVelocity * delta) * decay
        moving ||=
          Math.abs(current.value[index]! - target) > transition.restDelta ||
          Math.abs(current.velocity[index]!) > transition.restSpeed
      })
    }
    return moving
  }

  function advanceTween(now: number) {
    const transition = options.transition
    if (transition.type !== "tween") return false
    const progress = Math.min(1, (now - started) / 1_000 / Math.max(0.001, transition.duration))
    const eased = transition.ease(progress)
    for (const current of state.values())
      current.value.forEach((_, index) => {
        const from = current.from[index]!
        current.value[index] = from + (current.target[index]! - from) * eased
        current.velocity[index] = 0
      })
    return progress < 1
  }

  function read() {
    return Object.fromEntries(
      [...state].map(([key, current]) => [key, current.scalar ? current.value[0]! : [...current.value]]),
    ) as T
  }

  createEffect(() => {
    if (enabled()) return
    jump(target)
  })
  onCleanup(stop)

  return { value, animate, jump }
}

// Reveal pacing. The gap is the expected wait for the next streamed chunk, smoothed over recent arrivals and bounded
// so a pause (a tool call, a slow first token) does not stretch the next reveal.
const REVEAL_GAP_MIN = 16
const REVEAL_GAP_MAX = 400
const REVEAL_GAP_INITIAL = 80
const REVEAL_GAP_SMOOTHING = 0.3
// Once the stream ends, whatever is left lands within about this long.
const REVEAL_FINISH = 150

/**
 * Reveals text that grows while `live` character by character, so a streamed chunk of several words flows in instead
 * of landing at once. The pace follows the model: every chunk sets an even speed that lands the whole backlog over the
 * recent gap between chunks, about when the next chunk arrives. A fast model types fast, a slow one types smoothly. Text that is already there when the reveal starts outside a stream, and any change that is
 * not an append, shows at once.
 */
export function createTextReveal(
  text: Accessor<string>,
  options: { live: Accessor<boolean>; enabled: Accessor<boolean> },
) {
  const renderer = useRenderer()
  // A part that mounts mid-stream types its first chunk too; history shows whole.
  let position = options.enabled() && options.live() ? 0 : text().length
  const [shown, setShown] = createSignal(position)
  let previous = renderer.clock.now()
  let arrival: number | undefined
  let gap = REVEAL_GAP_INITIAL
  // Characters per millisecond, set so the current backlog lands within the horizon, at an even pace.
  let speed = 0
  let running = false

  const pace = (horizon: number) => {
    speed = Math.max(speed, (text().length - position) / horizon)
  }

  const step: AnimationTask = (now) => {
    const target = text().length
    const elapsed = Math.min(50, now - previous)
    previous = now
    if (!options.enabled() || position >= target) {
      position = target
      setShown(target)
      speed = 0
      running = false
      return false
    }
    if (speed === 0) pace(options.live() ? gap : REVEAL_FINISH)
    position = Math.min(target, position + speed * elapsed)
    setShown(Math.floor(position))
    running = position < target
    if (!running) speed = 0
    return running
  }

  const start = () => {
    if (running) return
    running = true
    previous = renderer.clock.now()
    schedule(renderer, step)
  }

  // `on` with defer reports no previous value on its first run, so the last text is kept here.
  let last = text()
  createEffect(
    on(
      text,
      (next) => {
        const previousText = last
        last = next
        const now = renderer.clock.now()
        if (!options.enabled() || !next.startsWith(previousText)) {
          position = next.length
          setShown(position)
          return
        }
        if (arrival !== undefined)
          gap = Math.min(REVEAL_GAP_MAX, Math.max(REVEAL_GAP_MIN, gap + (now - arrival - gap) * REVEAL_GAP_SMOOTHING))
        arrival = now
        // Re-pace on every chunk: the whole backlog should land about when the next chunk does.
        speed = 0
        pace(gap)
        start()
      },
      { defer: true },
    ),
  )
  // The stream ending speeds up the rest; disabling the reveal shows everything.
  createEffect(
    on(
      [options.live, options.enabled],
      () => {
        if (position >= text().length) return
        if (!options.live()) pace(REVEAL_FINISH)
        start()
      },
      { defer: true },
    ),
  )
  if (position < text().length) start()
  onCleanup(() => unschedule(renderer, step))

  return {
    text: () => {
      const full = text()
      if (!options.enabled()) return full
      const end = shown()
      if (end >= full.length) return full
      // Never split a surrogate pair.
      const code = full.charCodeAt(end - 1)
      return full.slice(0, code >= 0xd800 && code <= 0xdbff ? end + 1 : end)
    },
    revealing: () => options.enabled() && shown() < text().length,
  }
}

function values(value: AnimatableValue) {
  return typeof value === "number" ? [value] : [...value]
}

function clone<T extends AnimatableTarget>(target: T) {
  return Object.fromEntries(
    Object.entries(target).map(([key, value]) => [key, typeof value === "number" ? value : [...value]]),
  ) as T
}

function schedule(renderer: CliRenderer, task: AnimationTask) {
  const clock = clocks.get(renderer)
  if (clock) return void clock.tasks.add(task)
  const tasks = new Set([task])
  const stop = renderer.onAnimationTick(60, (_deltaTime, _ticks, now) => {
    for (const task of tasks) if (!task(now)) unschedule(renderer, task)
  })
  clocks.set(renderer, { tasks, stop })
}

function unschedule(renderer: CliRenderer, task: AnimationTask) {
  const clock = clocks.get(renderer)
  if (!clock?.tasks.delete(task) || clock.tasks.size > 0) return
  clock.stop()
  clocks.delete(renderer)
}
