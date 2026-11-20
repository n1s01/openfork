// OpenFork: accept OPENFORK_* environment variables as aliases of the upstream OPENCODE_* ones.
// Imported first from index.ts so every module (and spawned background services) sees them.
// An explicit OPENFORK_* value wins over an inherited OPENCODE_* one.
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith("OPENFORK_") || value === undefined) continue
  process.env["OPENCODE_" + key.slice("OPENFORK_".length)] = value
}

export {}
