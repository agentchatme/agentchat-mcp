import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  // bin script must be ESM with a shebang. tsup emits .js for ESM and .cjs
  // for CJS by default, which lines up with the package.json `bin` field
  // pointing at `./dist/index.js`.
  banner: { js: '#!/usr/bin/env node' },
  target: 'es2022',
  platform: 'node',
  dts: true,
  splitting: false,
  // No source maps in published artifact — keeps the npm tarball small and
  // avoids accidentally shipping source paths from the maintainer's box.
  sourcemap: false,
  clean: true,
  shims: false,
  // bundle dependencies, but NOT peerDependencies. We have no peerDeps
  // currently; if we add the OpenAI SDK or similar later, configure here.
  external: [],
  outExtension: ({ format }) => ({
    js: format === 'cjs' ? '.cjs' : '.js',
  }),
})
