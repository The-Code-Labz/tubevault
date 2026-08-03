import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { AuthProvider } from './lib/auth-context.tsx'
import { initSupabase } from './lib/supabase.ts'
import './index.css'

// Block first render on one same-origin fetch to /api/config so the Supabase
// client is fully configured before any component touches it.
initSupabase().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <AuthProvider>
      <App />
    </AuthProvider>
  )
})
