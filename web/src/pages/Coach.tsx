import { useState, type FormEvent } from 'react'
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

  return (
    <Card title="Ask KRATOS" className="mb-5" action={msgs.length > 0 && <button className="text-xs text-ash hover:text-bone" onClick={() => { setMsgs([]); local.set(KEY, null) }}>Clear</button>}>
      {!ai && !health.loading && (
        <Alert>The coach needs an LLM key. Add <code className="font-mono">KRATOS_LLM_API_KEY</code> to <code className="font-mono">.env</code> (NVIDIA NIM by default) and restart the API. Everything else works without it.</Alert>
      )}
      {msgs.length > 0 && (
        <ol className="mb-4 max-h-96 space-y-3 overflow-y-auto" aria-live="polite">
          {msgs.map((m, i) => (
            <li key={i} className={m.role === 'user' ? 'ml-auto max-w-[85%] rounded-xl rounded-br-sm bg-iron-800 px-4 py-2 text-sm' : 'max-w-[90%] whitespace-pre-line text-sm leading-relaxed text-bone/90'}>
              {m.content}
            </li>
          ))}
          {busy && <li className="text-sm text-ash">Thinking… replies can take up to a minute.</li>}
        </ol>
      )}
      {ai && !msgs.length && (
        <div className="mb-4 flex flex-wrap gap-2">
          {STARTERS.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border border-iron-700 px-3 py-1.5 text-left text-xs text-ash hover:border-accent hover:text-bone">{s}</button>)}
        </div>
      )}
      {err && <div className="mb-3"><Alert tone="error">{err}</Alert></div>}
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); send(text) }} className="flex gap-2">
        <input aria-label="Ask the coach" placeholder={ai ? 'Training, technique, programming…' : 'AI not configured'} disabled={!ai} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
        <Button busy={busy} disabled={!ai || !text.trim()}>Ask</Button>
      </form>
      <p className="mt-2 text-[11px] text-ash/80">Sends your goal, experience, equipment, limitations and plan names to {health.data?.model ?? 'the configured model'} — never body measurements or photos. Not medical advice.</p>
    </Card>
  )
}
