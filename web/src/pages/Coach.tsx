import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, local, useApi, type Profile } from '../api'
import { Alert, Button, Card, PageHead } from '../ui'
import ProfileAndGear from './ProfileGear'

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
      <PageHead kicker={profile ? 'AI Coach' : 'Welcome to KRATOS'} title={profile ? 'Goals, gear & questions' : 'Tell me about you'} />
      {!profile && <p className="-mt-3 mb-6 max-w-2xl text-ash">Your plan is built from this profile and the equipment you actually own. Everything stays in a local database on this machine.</p>}
      {profile && <Ask />}
      <ProfileAndGear onSaved={onSaved} />
    </>
  )
}

function Ask() {
  const health = useApi<{ ai: boolean; model: string | null }>('/health')
  const [msgs, setMsgs] = useState<Msg[]>(() => local.get<Msg[]>(KEY) ?? [])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const ai = health.data?.ai

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

  // A new reply opens at its first line; your message and the typing dots pin to the bottom.
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const ol = list.current
    const last = ol?.lastElementChild as HTMLElement | null
    if (!ol || !last) return
    ol.scrollTo({ top: msgs.at(-1)?.role === 'assistant' && !busy ? last.offsetTop - 16 : ol.scrollHeight, behavior: 'smooth' })
  }, [msgs, busy])

  return (
    <Card title="Ask KRATOS" className="mb-5" action={msgs.length > 0 && <button className="text-xs text-ash hover:text-bone" onClick={() => { setMsgs([]); local.set(KEY, null) }}>Clear chat</button>}>
      {!ai && !health.loading && (
        <div className="mb-4"><Alert>The coach needs an LLM key. Add <code className="font-mono">KRATOS_LLM_API_KEY</code> to <code className="font-mono">.env</code> (NVIDIA NIM by default) and restart the API. Everything else works without it.</Alert></div>
      )}
      <div className="flex h-[min(34rem,70dvh)] flex-col overflow-hidden rounded-lg border border-iron-800 bg-iron-950">
        <ol ref={list} className="relative flex-1 space-y-4 overflow-y-auto overscroll-contain p-4" aria-live="polite" aria-label="Conversation with KRATOS">
          {!msgs.length && (
            <li className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <Avatar />
              <p className="max-w-sm text-sm text-ash">Ask about training, technique, programming or recovery. I know your goal, gear and plan.</p>
              {ai && (
                <div className="flex max-w-xl flex-wrap justify-center gap-2">
                  {STARTERS.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border border-iron-700 px-3 py-1.5 text-xs text-ash hover:border-accent hover:text-bone">{s}</button>)}
                </div>
              )}
            </li>
          )}
          {msgs.map((m, i) => m.role === 'user' ? (
            <li key={i} className="flex justify-end">
              <p className="max-w-[85%] whitespace-pre-line rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-sm font-medium text-iron-950">{m.content}</p>
            </li>
          ) : (
            <li key={i} className="flex items-start gap-3">
              <Avatar />
              <p className="max-w-[85%] whitespace-pre-line rounded-2xl rounded-tl-sm bg-iron-800 px-4 py-3 text-sm leading-relaxed text-bone/90">{emphasis(m.content)}</p>
            </li>
          ))}
          {busy && (
            <li className="flex items-start gap-3">
              <Avatar />
              <div className="rounded-2xl rounded-tl-sm bg-iron-800 px-4 py-3">
                <span className="flex gap-1" aria-hidden>
                  {['0s', '0.15s', '0.3s'].map((d) => <span key={d} className="size-1.5 animate-bounce rounded-full bg-ash" style={{ animationDelay: d }} />)}
                </span>
                <span className="mt-2 block text-xs text-ash">Thinking… replies can take up to a minute.</span>
              </div>
            </li>
          )}
        </ol>
        {err && <div className="border-t border-iron-800 px-3 pt-3"><Alert tone="error">{err}</Alert></div>}
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); send(text) }} className="flex items-end gap-2 border-t border-iron-800 bg-iron-900 p-3">
          <textarea aria-label="Message the coach" rows={1} placeholder={ai ? 'Message KRATOS…  (Shift+Enter for a new line)' : 'AI not configured'} disabled={!ai} value={text} maxLength={2000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text) } }}
            className="max-h-32 min-h-10 flex-1 resize-none rounded-md border border-iron-700 bg-iron-950 px-3 py-2 text-sm text-bone [field-sizing:content] placeholder:text-ash/70 focus:border-accent focus:outline-none" />
          <Button busy={busy} disabled={!ai || !text.trim()}>Send</Button>
        </form>
      </div>
      <p className="mt-2 text-[11px] text-ash/80">Sends your goal, experience, equipment, limitations and plan names to {health.data?.model ?? 'the configured model'} — never body measurements or photos. Not medical advice.</p>
    </Card>
  )
}

const Avatar = () => <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-accent font-display text-xs font-bold text-iron-950">K</span>

// The model writes light markdown despite the prompt: show **bold** and *italic* as emphasis (React text, never HTML).
const EMPHASIS = /(\*\*[^*\n]+?\*\*|\*[^*\s][^*\n]*?\*)/
const emphasis = (t: string) => t.split(EMPHASIS).map((p, i) =>
  i % 2 === 0 ? p : p.startsWith('**') ? <strong key={i} className="font-semibold text-bone">{p.slice(2, -2)}</strong> : <em key={i}>{p.slice(1, -1)}</em>)
