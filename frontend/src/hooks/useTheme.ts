import { useState } from 'react'
import { load, save } from '../lib/storage'

export type Theme = 'dark' | 'light'
const KEY = 'pipdesk.theme'

// The class is applied synchronously (not in an effect) so that components
// reading CSS variables in their own effects, like the chart, see the new theme.
function apply(theme: Theme): Theme {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  save(KEY, theme)
  return theme
}

function initialTheme(): Theme {
  const saved = load<string | null>(KEY, null)
  if (saved === 'dark' || saved === 'light') return apply(saved)
  return apply(window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme)
  return [theme, () => setTheme(apply(theme === 'dark' ? 'light' : 'dark'))]
}
