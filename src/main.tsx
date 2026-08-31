import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/base.css'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Mount point #root is missing from index.html')
}

createRoot(root).render(
  <StrictMode>
    <main className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">MineralFlows</h1>
      <p className="max-w-md text-sm text-neutral-400">
        Where critical minerals are mined, processed, and refined, and how they move between
        countries.
      </p>
      <p className="font-mono text-xs text-neutral-600">
        Scaffold deployed. Globe and data not built yet.
      </p>
    </main>
  </StrictMode>,
)
