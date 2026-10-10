import MusicPage from '../music/MusicPage'
import TimersPage from '../timer/TimersPage'
import { PageHead } from '../ui'
import Import from './Import'
import { DataCard } from './ProfileGear'
import { Link } from '../router'

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
        </div>
      )}
    </>
  )
}
