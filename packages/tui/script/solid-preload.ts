// Dev and test preload: OpenTUI's Solid transform runs Babel on every .tsx load and caches
// nothing, about 3.5 s for the TUI sources on each `bun run dev`. This wraps the same transform
// in a content-addressed disk cache, and loads Babel only when a file misses the cache.
import { plugin, type PluginBuilder } from "bun"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

type Load = (args: { path: string }) => Promise<{ contents: string; loader: "js" }>

// OpenTUI's own registration state. Marking it installed keeps the runtime plugin support from
// registering the stock plugin as well; it still records its moduleName and resolvePath here.
type State = { installed: boolean; runtime?: { moduleName?: string; resolvePath?: unknown } }
const shared = globalThis as unknown as Record<symbol, State | undefined>
const state = (shared[Symbol.for("opentui.solid.transform")] ??= { installed: false })

const root = path.join(import.meta.dir, "../../..")
const cache = path.join(root, "node_modules/.cache/opentui-solid")
// The resolved plugin path carries the OpenTUI version; the lockfile covers Babel and presets.
const salt = `${import.meta.resolve("@opentui/solid/bun-plugin")}\0${Bun.hash(await Bun.file(path.join(root, "bun.lock")).arrayBuffer())}`

let stock: Promise<Load> | undefined
const transform = (args: { path: string }) =>
  (stock ??= import("@opentui/solid/bun-plugin").then(({ createSolidTransformPlugin }) => {
    const handlers: { filter: RegExp; load: Load }[] = []
    const builder = { onLoad: (options: { filter: RegExp }, load: Load) => handlers.push({ filter: options.filter, load }) }
    createSolidTransformPlugin().setup(builder as unknown as PluginBuilder)
    const source = handlers.find((handler) => handler.filter.test("file.tsx"))
    if (!source) throw new Error("OpenTUI's Solid plugin registered no .tsx handler")
    return source.load
  })).then((load) => load(args))

if (!state.installed) {
  state.installed = true
  plugin({
    name: "bun-plugin-solid-cached",
    setup(build) {
      // Solid's server builds swap for the browser ones, as in the stock plugin.
      build.onLoad({ filter: /[/\\]node_modules[/\\]solid-js[/\\]dist[/\\]server\.js(?:[?#].*)?$/ }, async (args) => ({
        contents: await readFile(strip(args.path).replace("server.js", "solid.js"), "utf8"),
        loader: "js",
      }))
      build.onLoad(
        { filter: /[/\\]node_modules[/\\]solid-js[/\\]store[/\\]dist[/\\]server\.js(?:[?#].*)?$/ },
        async (args) => ({
          contents: await readFile(strip(args.path).replace("server.js", "store.js"), "utf8"),
          loader: "js",
        }),
      )
      build.onLoad({ filter: /\.[cm]?[jt]sx(?:[?#].*)?$/ }, async (args) => {
        const runtime = state.runtime
        // A resolvePath function changes the output in ways a content hash cannot see.
        if (runtime?.resolvePath) return transform(args)
        const file = strip(args.path)
        const code = await readFile(file, "utf8")
        const key = Bun.hash(`${salt}\0${runtime?.moduleName ?? ""}\0${file}\0${code}`).toString(36)
        const target = path.join(cache, `${key}.js`)
        const cached = await readFile(target, "utf8").catch(() => undefined)
        if (cached !== undefined) return { contents: cached, loader: "js" }
        const result = await transform(args)
        await mkdir(cache, { recursive: true })
        // Concurrent processes (tests, dev servers) may write the same entry; rename is atomic.
        const temp = `${target}.${process.pid}.tmp`
        await writeFile(temp, result.contents)
        await rename(temp, target)
        return result
      })
    },
  })
}

function strip(file: string) {
  const end = file.search(/[?#]/)
  return end === -1 ? file : file.slice(0, end)
}
