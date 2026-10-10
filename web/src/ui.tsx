import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Link } from './router'

const BTN = {
  primary: 'bg-accent text-iron-950 hover:bg-accent-hi',
  ghost: 'border border-iron-700 text-bone hover:border-iron-600 hover:bg-iron-800',
  danger: 'border border-ember/50 text-ember hover:bg-ember/10',
}

export function Button({ variant = 'primary', busy, className = '', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BTN; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${BTN[variant]} ${className}`}
    >
      {busy && <span className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden />}
      {children}
    </button>
  )
}

export function Card({ title, action, children, className = '' }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-iron-700 bg-iron-900 p-4 sm:p-5 ${className}`}>
      {(title || action) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="font-display text-sm font-semibold uppercase tracking-[0.14em] text-ash">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ash">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ash/80">{hint}</span>}
    </label>
  )
}

export function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${on ? 'border-accent bg-accent/15 text-accent-hi' : 'border-iron-700 text-ash hover:border-iron-600 hover:text-bone'}`}>
      {children}
    </button>
  )
}

export function Stat({ label, value, unit }: { label: string; value: ReactNode; unit?: string }) {
  return (
    <div>
      <div className="text-xs text-ash">{label}</div>
      <div className="font-mono text-2xl font-bold text-bone">
        {value}
        {unit && <span className="ml-1 text-sm font-medium text-ash">{unit}</span>}
      </div>
    </div>
  )
}

export function Alert({ tone = 'warn', children }: { tone?: 'warn' | 'error' | 'ok'; children: ReactNode }) {
  const c = { warn: 'border-accent/40 bg-accent/10 text-accent-hi', error: 'border-ember/50 bg-ember/10 text-ember', ok: 'border-sage/40 bg-sage/10 text-sage' }[tone]
  return <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border px-3 py-2 text-sm ${c}`}>{children}</div>
}

export function PageHead({ kicker, title, children }: { kicker: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-accent">{kicker}</p>
        <h1 className="font-display text-3xl font-bold uppercase tracking-wide sm:text-4xl">{title}</h1>
      </div>
      {children}
    </div>
  )
}

export const Spinner = () => <div className="grid min-h-40 place-items-center text-sm text-ash">Loading…</div>

export function LinkButton({ href, variant = 'primary', children }: { href: string; variant?: keyof typeof BTN; children: ReactNode }) {
  return <Link href={href} className={`inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors ${BTN[variant]}`}>{children}</Link>
}
