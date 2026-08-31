import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell } from './components/AppShell.tsx'
import './styles/base.css'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Mount point #root is missing from index.html')
}

createRoot(root).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
)
