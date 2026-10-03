import { useEffect, useState } from 'react'
import { Check, Copy, ArrowLeft } from 'lucide-react'
import { VaultMark, VaultWordmark } from './VaultMark.tsx'

const API_BASE = import.meta.env.VITE_API_BASE_URL || ''

export function DocsPage() {
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    fetch(`${API_BASE}/api/docs`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load docs: ${res.status}`)
        return res.json()
      })
      .then((data) => setMarkdown(data.markdown))
      .catch((err) => setError(err.message))
  }, [])

  async function copyMarkdown() {
    if (!markdown) return
    await navigator.clipboard.writeText(markdown)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="min-h-screen bg-chrome text-paper">
      <header className="sticky top-0 z-30 border-b border-border bg-chrome">
        <div className="mx-auto flex h-16 max-w-[1024px] items-center gap-3 px-5 sm:px-7">
          <VaultMark size={26} className="shrink-0 text-gold" />
          <VaultWordmark withDescriptor />
          <div className="ml-auto flex items-center gap-2">
            <a
              href="/"
              className="flex h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-paper-muted transition hover:border-border-strong hover:text-paper"
            >
              <ArrowLeft size={16} aria-hidden="true" />
              Back
            </a>
            <button
              type="button"
              onClick={copyMarkdown}
              disabled={!markdown}
              className="flex h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-paper-muted transition hover:border-border-strong hover:text-paper disabled:opacity-50"
            >
              {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
              {copied ? 'Copied' : 'Copy as Markdown'}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1024px] px-5 py-10 sm:px-7">
        {error && <p className="text-sm text-red-400">{error}</p>}
        {!error && !markdown && <p className="text-sm text-paper-muted">Loading...</p>}
        {markdown && (
          <pre className="whitespace-pre-wrap break-words rounded-lg border border-border bg-black/20 p-5 font-mono text-sm leading-relaxed text-paper">
            {markdown}
          </pre>
        )}
      </main>
    </div>
  )
}
