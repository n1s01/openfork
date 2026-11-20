// Deep re-exports of the @effect/platform-node modules the CLI and server entrypoints use. The
// package barrel also loads NodeRedis (@redis/client and friends, 600+ files), which costs those
// entrypoints over 100 ms wherever the bundler does not tree-shake it (dev runs, `bun run`).
export * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
export * as NodeRuntime from "@effect/platform-node/NodeRuntime"
export * as NodeServices from "@effect/platform-node/NodeServices"
export * as NodeSocket from "@effect/platform-node/NodeSocket"
