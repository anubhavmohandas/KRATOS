import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { useApi, type Profile } from './api'
import { Link, navigate, usePath } from './router'
import { Alert, LinkButton, PageHead, Spinner } from './ui'
import { MiniPlayer, MusicProvider } from './music/Music'
import { TimerChip, TimerProvider } from './timer/Timer'
import Dashboard from './pages/Dashboard'
import Train from './pages/Train'
import Coach, { CoachChat } from './pages/Coach'
import Body from './pages/Body'
import Progress from './pages/Progress'
import Space from './pages/Space'

// [path segment, label, icon, allowed sub-paths]
const TABS = [
  ['', 'Dashboard', 'M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z', ['']],
  ['train', 'Train', 'M4 12h3m10 0h3M7 8v8m10-8v8M7 12h10', ['', 'library', 'versions']],
  ['coach', 'Profile', 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0', ['']],
  ['body', 'Body Lab', 'M12 4a2 2 0 1 0 0 .01M8 21l2-8-3-3 5-2 5 2-3 3 2 8', ['']],
  ['progress', 'Progress', 'M4 19l5-6 4 3 7-9', ['']],
  ['space', 'My Space', 'M9 18V6l11-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z', ['', 'music', 'timers', 'pdf', 'settings']],
] as const
type Tab = (typeof TABS)[number]

/** `/space/timers` → [space tab, 'timers']; `null` tab = no such page. */
function useRoute(): [Tab | null, string] {
  const [seg = '', sub = '', extra] = usePath().slice(1).replace(/\/$/, '').split('/')
  const tab = TABS.find((t) => t[0] === seg) ?? null
  return [tab && (tab[3] as readonly string[]).includes(sub) && extra === undefined ? tab : null, sub]
}

function Icon({ d }: { d: string }) {
  return <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
}

function App() {
  const [tab, sub] = useRoute()
  const id = tab?.[0]
  const profile = useApi<Profile | null>('/profile')
  const p = profile.data
  const onSaved = (np: Profile) => {
    const first = !p
    profile.setData(np)
    if (first) navigate('/train')
  }
  useEffect(() => {
    document.title = !tab ? 'Not found · KRATOS' : id ? `${tab[1]} · KRATOS` : 'KRATOS'
  }, [tab, id])

  let page
  if (profile.loading) page = <Spinner />
  else if (profile.error) page = <Alert tone="error">{profile.error.message} Start it with <code className="font-mono">./start.sh</code>.</Alert>
  else if (!tab) page = <><PageHead kicker="404" title="No such page" /><LinkButton href="/">Back to dashboard</LinkButton></>
  else if (!p || id === 'coach') page = <Coach profile={p} onSaved={onSaved} />
  else page = { '': <Dashboard profile={p} />, train: <Train profile={p} sub={sub} />, body: <Body profile={p} />, progress: <Progress profile={p} />, space: <Space sub={sub} /> }[id as string]

  return (
    <div className="min-h-dvh lg:pl-60">
      <aside className="fixed inset-x-0 bottom-0 z-20 border-t border-iron-800 bg-iron-950/95 backdrop-blur lg:inset-y-0 lg:left-0 lg:right-auto lg:flex lg:w-60 lg:flex-col lg:border-r lg:border-t-0">
        <Link href="/" className="hidden px-6 pb-6 pt-7 lg:block" aria-label="KRATOS dashboard">
          <span className="block font-display text-2xl font-bold tracking-[0.2em]">KRATOS</span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-ash">Personal fitness intelligence</span>
        </Link>
        <div className="px-2 pt-2 lg:order-last lg:mt-auto lg:space-y-2 lg:p-3"><MiniPlayer /></div>
        <nav aria-label="Main">
          <ul className="flex justify-around lg:flex-col lg:gap-1 lg:px-3">
            {TABS.map(([seg, label, d]) => (
              <li key={seg}>
                <Link href={`/${seg}`} aria-current={id === seg ? 'page' : undefined}
                  className={`flex flex-col items-center gap-1 px-1.5 py-2.5 text-[10px] transition-colors sm:px-3 sm:text-[11px] lg:flex-row lg:gap-3 lg:rounded-lg lg:text-sm ${id === seg ? 'text-accent lg:bg-iron-850' : 'text-ash hover:text-bone'}`}>
                  <Icon d={d} />{label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      <main className="mx-auto max-w-6xl px-4 pb-60 pt-5 sm:px-6 lg:pb-28 lg:pt-10">
        <div className="mb-4 flex min-h-8 items-center justify-between gap-3 lg:justify-end">
          <span className="font-display text-lg font-bold tracking-[0.2em] lg:hidden">KRATOS</span>
          <TimerChip />
        </div>
        {page}
      </main>
      {p && <CoachChat />}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TimerProvider>
      <MusicProvider>
        <App />
      </MusicProvider>
    </TimerProvider>
  </StrictMode>,
)
