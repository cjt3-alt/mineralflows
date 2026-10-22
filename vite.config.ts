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
    // The largest chunk is Natural Earth's 1:50m country outlines (~760 kB raw,
    // ~240 kB gzipped), which the map fetches only when zoomed in. It is data,
    // not code, so the default 500 kB warning would only ever flag it.
    chunkSizeWarningLimit: 800,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: false,
  },
})
