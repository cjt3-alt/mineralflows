import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Relative base so one build works in all three places we serve it from:
// the project page at <user>.github.io/mineralflows/, the apex domain once
// DNS is cut over, and a plain `file://` / static file server.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    sourcemap: true,
    // three.js plus globe.gl is ~2 MB before compression and all of it is
    // needed on first paint, so the default 500 kB warning would fire on every
    // build forever. Raised deliberately rather than ignored.
    chunkSizeWarningLimit: 3000,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: false,
  },
})
