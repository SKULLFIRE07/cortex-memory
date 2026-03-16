import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/extension/index.ts'],
  format: ['cjs'],
  outDir: 'dist',
  external: ['vscode'],
  noExternal: ['chokidar'],
  clean: true,
  sourcemap: false,
  minify: false,
  target: 'es2022',
});
