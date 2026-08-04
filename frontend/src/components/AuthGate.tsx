import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { VaultMark, VaultWordmark } from './VaultMark.tsx'
import { InlineAlert } from './InlineAlert.tsx'
import { useAuth } from '../lib/auth-context.tsx'

const STEPS = [
  { title: 'Add a source URL', body: 'Paste a supported video link into the ingest rail.' },
  { title: 'Watch it move through the queue', body: 'Track download, processing, and upload stages in real time.' },
  { title: 'Play it from private storage', body: 'Stream the stored file back whenever you need it.' },
]

export function AuthGate() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const result = await signIn(email, password)
    setSubmitting(false)
    if (result) setError(result)
  }

  return (
    <div className="min-h-[100dvh] bg-canvas text-paper">
      <div className="mx-auto flex min-h-[100dvh] max-w-[1440px] flex-col gap-10 px-5 py-10 sm:px-7 sm:py-14 lg:flex-row lg:items-center lg:gap-16 lg:px-10 lg:py-0">
        <div className="flex flex-1 flex-col gap-6 lg:max-w-xl">
          <div className="flex items-center gap-2.5">
            <VaultMark size={26} className="text-gold" />
            <VaultWordmark />
          </div>

          <h1 className="max-w-[16ch] text-[28px] font-semibold leading-[33px] text-paper sm:text-[32px] sm:leading-[36px] lg:text-[44px] lg:leading-[48px]">
            Your private intake desk for video.
          </h1>

          <ol className="flex flex-col gap-4">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border font-mono text-xs text-gold">
                  {i + 1}
                </span>
                <div className="flex flex-col gap-0.5">
                  <p className="text-[15px] font-medium leading-[21px] text-paper">{step.title}</p>
                  <p className="text-sm leading-[20px] text-paper-muted">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>

          <p className="max-w-md text-xs leading-[18px] text-paper-subtle">
            Access is invite-only and provisioned by an administrator — there is no public sign-up.
            Archive only media you own or are permitted to download.
          </p>
        </div>

        <div className="w-full shrink-0 lg:max-w-sm">
          <div className="rounded-xl border border-border bg-surface p-6 sm:p-8">
            <h2 className="mb-1 text-lg font-semibold text-paper">Sign in</h2>
            <p className="mb-6 text-sm text-paper-muted">Use the credentials your administrator provided.</p>

            {error ? (
              <div className="mb-4">
                <InlineAlert tone="danger" message={error} />
              </div>
            ) : null}

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div>
                <label htmlFor="email" className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-paper-muted">
                  Email
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-11 w-full rounded-lg border border-border bg-canvas px-3 text-[15px] text-paper outline-none transition focus-visible:border-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
                />
              </div>
              <div>
                <label htmlFor="password" className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-paper-muted">
                  Password
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-11 w-full rounded-lg border border-border bg-canvas px-3 text-[15px] text-paper outline-none transition focus-visible:border-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="mt-2 flex h-12 items-center justify-center gap-2 rounded-lg bg-gold text-[15px] font-semibold text-canvas transition hover:bg-gold-hover active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
              >
                {submitting ? (
                  <Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                ) : null}
                Sign in
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}
