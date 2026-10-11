import MusicPage from '../music/MusicPage'
import TimersPage from '../timer/TimersPage'
import { PageHead } from '../ui'
import Import from './Import'
import { DataCard } from './ProfileGear'
import { Link } from '../router'
import { api } from '../api'

const TABS = [['music', 'Music'], ['timers', 'Timers'], ['pdf', 'PDF Studio'], ['settings', 'Settings']] as const

export default function Space({ sub }: { sub: string }) {
  const tab = TABS.some(([k]) => k === sub) ? sub : 'music'
  return (
    <>
      <PageHead kicker="My Space" title={TABS.find(([k]) => k === tab)![1]} />
      <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-iron-800" aria-label="My Space sections">
        {TABS.map(([k, label]) => (
          <Link key={k} href={`/space/${k}`} aria-current={tab === k ? 'page' : undefined}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-accent text-bone' : 'border-transparent text-ash hover:text-bone'}`}>{label}</Link>
        ))}
      </nav>
      {tab === 'music' ? <MusicPage /> : tab === 'timers' ? <TimersPage /> : tab === 'pdf' ? <Import /> : (
        <div className="space-y-5">
          <DataCard />
          <p className="text-sm text-ash">Install KRATOS as an app: in Chrome or Edge use the install icon in the address bar; on iPhone, Share → Add to Home Screen. Music files live in this browser; workouts and body data live in <code className="font-mono">api/kratos.db</code>.</p>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <a href="/logout" className="text-ash underline hover:text-bone">Log out of this device</a>
            <button className="text-ash underline hover:text-ember" onClick={logoutEverywhere}>Log out everywhere</button>
          </div>
        </div>
      )}
    </>
  )
}

async function logoutEverywhere() {
  if (!confirm('Log out every device, this one included? Use it if a phone or laptop signed in to KRATOS is lost.')) return
  try {
    await api.send('/logout-everywhere', 'POST')
    location.assign('/login')
  } catch (e) {
    alert(`Couldn’t log out everywhere: ${(e as Error).message}`)
  }
}
