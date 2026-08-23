import { defineConfig } from 'tsup'

// Two artifacts, one source tree:
//   * dist/index.{js,cjs} — the stdio BIN entry. Shebang'd, auto-runs on
//     execution. `package.json#bin` points here; behavior is unchanged.
//   * dist/lib.{js,cjs}   — the LIBRARY entry (`buildMcpServer`). No shebang,
//     no side effects on import. `package.json#exports/main/module/types`
//     point here so `import '@agentchatme/mcp'` composes servers instead of
//     accidentally booting one.
// tsup runs array configs sequentially; only the first cleans dist/ so the
// second build cannot delete the first's output.
const shared = {
  format: ['esm', 'cjs'],
  target: 'node22',
  platform: 'node',
  dts: true,
  splitting: false,
  // No source maps in published artifact — keeps the npm tarball small and
  // avoids accidentally shipping source paths from the maintainer's box.
  sourcemap: false,
  shims: false,
  // bundle dependencies, but NOT peerDependencies. We have no peerDeps
  // currently; if we add the OpenAI SDK or similar later, configure here.
  external: [],
  outExtension: ({ format }: { format: string }) => ({
    js: format === 'cjs' ? '.cjs' : '.js',
  }),
} satisfies Parameters<typeof defineConfig>[0]

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    // bin script must be ESM with a shebang. tsup emits .js for ESM and .cjs
    // for CJS by default, which lines up with the package.json `bin` field
    // pointing at `./dist/index.js`.
    banner: { js: '#!/usr/bin/env node' },
    clean: true,
  },
  {
    ...shared,
    entry: { lib: 'src/lib.ts' },
    clean: false,
  },
])
