import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { DocsPage } from './components/DocsPage.tsx'
import { AuthProvider } from './lib/auth-context.tsx'
import { initSupabase } from './lib/supabase.ts'
import './index.css'

// /docs is public and doesn't need a Supabase session — render it directly
// without waiting on initSupabase (no router dependency needed for one static route).
if (window.location.pathname === '/docs') {
  ReactDOM.createRoot(document.getElementById('root')!).render(<DocsPage />)
} else {
  // Block first render on one same-origin fetch to /api/config so the Supabase
  // client is fully configured before any component touches it.
  initSupabase().finally(() => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <AuthProvider>
        <App />
      </AuthProvider>
    )
  })
}
