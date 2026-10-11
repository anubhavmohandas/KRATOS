import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, local, useApi, type Profile } from '../api'
import { Alert, Button, PageHead } from '../ui'
import ProfileAndGear from './ProfileGear'
import { Link } from '../router'

type Msg = { role: 'user' | 'assistant'; content: string }
const KEY = 'kratos.coach'
const STARTERS = [
  'My heaviest dumbbells feel light now — how do I keep progressing?',
  'What should I do on rest days?',
  'How do I know if I’m training hard enough?',
  'Should I add cardio for my goal?',
]

export default function Coach({ profile, onSaved }: { profile: Profile | null; onSaved: (p: Profile) => void }) {
  return (
    <>
      <PageHead kicker={profile ? 'Profile' : 'Welcome to KRATOS'} title={profile ? 'Goals & gear' : 'Tell me about you'} />
      {!profile && <p className="-mt-3 mb-6 max-w-2xl text-ash">Your plan is built from this profile and the equipment you actually own. Coming back after a wipe? <Link href="/space/settings" className="text-accent hover:underline">Restore a backup</Link> instead.</p>}
      <ProfileAndGear onSaved={onSaved} />
    </>
  )
}

/** Ask KRATOS: a chat docked bottom-right on every page. Full-screen below lg, a panel above the launcher on desktop. */
export function CoachChat() {
  const health = useApi<{ ai: boolean; model: string | null }>('/health')
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState<Msg[]>(() => local.get<Msg[]>(KEY) ?? [])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const ai = health.data?.ai
  const launcher = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLOListElement>(null)

  async function send(content: string) {
    content = content.trim().slice(0, 2000)
    if (!content || busy) return
    const next = [...msgs, { role: 'user' as const, content }]
    setMsgs(next)
    setText('')
    setBusy(true)
    setErr('')
    try {
      const r = await api.send<{ text: string }>('/coach', 'POST', { messages: next.slice(-12) })
      const all = [...next, { role: 'assistant' as const, content: r.text }].slice(-40)
      setMsgs(all)
      local.set(KEY, all)
    } catch (e) {
      setErr((e as Error).message)
      setMsgs(msgs)
      setText(content)
    } finally {
      setBusy(false)
    }
  }

  function close() {
    setOpen(false)
    launcher.current?.focus()
  }

  // Focus moves into the chat (the close button when AI is off and the box is disabled); Esc closes it from anywhere.
  useEffect(() => {
    if (!open) return
    input.current?.focus()
    if (document.activeElement !== input.current) closeBtn.current?.focus()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close()
    addEventListener('keydown', esc)
    return () => removeEventListener('keydown', esc)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // A new reply opens at its first line; your message and the typing dots pin to the bottom.
  useEffect(() => {
    const ol = list.current
    const last = ol?.lastElementChild as HTMLElement | null
    if (!ol || !last) return
    ol.scrollTo({ top: msgs.at(-1)?.role === 'assistant' && !busy ? last.offsetTop - 16 : ol.scrollHeight, behavior: 'smooth' })
  }, [msgs, busy, open])

  return (
    <>
      {open && (
        <section role="dialog" aria-label="Ask KRATOS"
          className="fixed inset-2 z-50 flex flex-col overflow-hidden rounded-xl border border-iron-700 bg-iron-950 shadow-2xl shadow-black lg:inset-auto lg:bottom-24 lg:right-6 lg:h-[min(36rem,calc(100dvh-8rem))] lg:w-96">
          <header className="flex items-center gap-3 border-b border-iron-800 bg-iron-900 px-4 py-3">
            <Avatar />
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-sm font-semibold uppercase tracking-[0.14em]">Ask KRATOS</h2>
              <p className="truncate text-[11px] text-ash">{ai ? health.data?.model : 'AI not configured'}</p>
            </div>
            {msgs.length > 0 && <button className="text-xs text-ash hover:text-bone" onClick={() => { setMsgs([]); local.set(KEY, null) }}>Clear</button>}
            <button ref={closeBtn} className="grid size-8 place-items-center rounded-md text-ash hover:bg-iron-800 hover:text-bone" aria-label="Close chat" onClick={close}><Svg d="M6 6l12 12M18 6L6 18" /></button>
          </header>

          <ol ref={list} className="relative flex-1 space-y-4 overflow-y-auto overscroll-contain p-4" aria-live="polite" aria-label="Conversation">
            {!msgs.length && (
              <li className="flex h-full flex-col items-center justify-center gap-4 text-center">
                <p className="max-w-xs text-sm text-ash">Ask about training, technique, programming or recovery. I know your goal, gear and plan.</p>
                {ai && STARTERS.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border border-iron-700 px-3 py-1.5 text-xs text-ash hover:border-accent hover:text-bone">{s}</button>)}
              </li>
            )}
            {msgs.map((m, i) => m.role === 'user' ? (
              <li key={i} className="flex justify-end">
                <p className="max-w-[85%] whitespace-pre-line rounded-2xl rounded-br-sm bg-accent px-3.5 py-2 text-sm font-medium text-iron-950">{m.content}</p>
              </li>
            ) : (
              <li key={i} className="flex items-start gap-2">
                <Avatar />
                <p className="max-w-[85%] whitespace-pre-line rounded-2xl rounded-tl-sm bg-iron-800 px-3.5 py-2.5 text-sm leading-relaxed text-bone/90">{emphasis(m.content)}</p>
              </li>
            ))}
            {busy && (
              <li className="flex items-start gap-2">
                <Avatar />
                <div className="rounded-2xl rounded-tl-sm bg-iron-800 px-3.5 py-2.5">
                  <span className="flex gap-1" aria-hidden>
                    {['0s', '0.15s', '0.3s'].map((d) => <span key={d} className="size-1.5 animate-bounce rounded-full bg-ash" style={{ animationDelay: d }} />)}
                  </span>
                  <span className="mt-2 block text-xs text-ash">Thinking… replies can take up to a minute.</span>
                </div>
              </li>
            )}
          </ol>

          {!ai && !health.loading && (
            <div className="px-3 pb-3"><Alert>Add <code className="font-mono">KRATOS_LLM_API_KEY</code> to <code className="font-mono">.env</code> and restart the API to chat. Everything else works without it.</Alert></div>
          )}
          {err && <div className="px-3 pb-3"><Alert tone="error">{err}</Alert></div>}
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); send(text) }} className="border-t border-iron-800 bg-iron-900 p-3">
            <div className="flex items-end gap-2">
              <textarea ref={input} aria-label="Message the coach" rows={1} placeholder={ai ? 'Message KRATOS…' : 'AI not configured'} disabled={!ai} value={text} maxLength={2000}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text) } }}
                className="max-h-32 min-h-10 flex-1 resize-none rounded-md border border-iron-700 bg-iron-950 px-3 py-2 text-sm text-bone [field-sizing:content] placeholder:text-ash/70 focus:border-accent focus:outline-none" />
              <Button busy={busy} disabled={!ai || !text.trim()} aria-label="Send"><Svg d="M5 12h14M13 6l6 6-6 6" /></Button>
            </div>
            <p className="mt-2 text-[10px] leading-snug text-ash/80">Shares your goal, gear, limitations and plan names — never body data or photos. Not medical advice.</p>
          </form>
        </section>
      )}

      <button ref={launcher} onClick={() => (open ? close() : setOpen(true))} aria-expanded={open} aria-label={open ? 'Close chat' : 'Ask KRATOS'}
        className={`fixed bottom-40 right-4 z-40 grid size-14 place-items-center rounded-full bg-accent text-iron-950 shadow-lg shadow-black/60 transition-colors hover:bg-accent-hi lg:bottom-6 lg:right-6 ${open ? 'max-lg:hidden' : ''}`}>
        <Svg d={open ? 'M6 6l12 12M18 6L6 18' : 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z'} />
        {busy && !open && <span className="absolute right-0.5 top-0.5 size-3 animate-pulse rounded-full border-2 border-iron-950 bg-ember" aria-hidden />}
      </button>
    </>
  )
}

const Avatar = () => <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-accent font-display text-xs font-bold text-iron-950">K</span>
const Svg = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>

// The model writes light markdown despite the prompt: show **bold** and *italic* as emphasis (React text, never HTML).
const EMPHASIS = /(\*\*[^*\n]+?\*\*|\*[^*\s][^*\n]*?\*)/
const emphasis = (t: string) => t.split(EMPHASIS).map((p, i) =>
  i % 2 === 0 ? p : p.startsWith('**') ? <strong key={i} className="font-semibold text-bone">{p.slice(2, -2)}</strong> : <em key={i}>{p.slice(1, -1)}</em>)
