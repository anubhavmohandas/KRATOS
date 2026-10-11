import { useState, type FormEvent } from 'react'
import { Cover, mmss, Transport, useMusic } from './Music'
import type { PlaylistKind } from './db'
import { Alert, Button, Card, Chip } from '../ui'

const KINDS: Record<PlaylistKind, string> = { warmup: 'Warm-up', strength: 'Strength', cardio: 'Cardio', cooldown: 'Cool-down', custom: 'Custom' }

export default function MusicPage() {
  const m = useMusic()
  const [sel, setSel] = useState<string>('all')
  const [newName, setNewName] = useState('')
  const [newKind, setNewKind] = useState<PlaylistKind>('strength')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [link, setLink] = useState('')
  const [ytMsg, setYtMsg] = useState('')
  const pl = m.playlists.find((p) => p.id === sel)
  const ids = pl ? pl.trackIds.filter((id) => m.tracks.some((t) => t.id === id)) : m.tracks.map((t) => t.id)
  const byId = Object.fromEntries(m.tracks.map((t) => [t.id, t]))

  async function onFiles(files: FileList | null) {
    if (!files?.length) return
    setBusy(true)
    setErrors(await m.importFiles(files, pl?.id))
    setBusy(false)
  }
  async function addLink(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setYtMsg('')
    const r = await m.addYouTube(link, pl?.id)
    setBusy(false)
    if (r.error) return setErrors([r.error])
    setErrors([])
    setLink('')
    setYtMsg(`Added ${r.added} video${r.added === 1 ? '' : 's'}${r.playlistId && r.playlistId !== pl?.id ? ' as a new playlist' : ''}.`)
    if (r.playlistId) setSel(r.playlistId)
  }
  function move(i: number, d: -1 | 1) {
    if (!pl) return
    const t = [...pl.trackIds]
    ;[t[i], t[i + d]] = [t[i + d], t[i]]
    m.savePlaylist({ ...pl, trackIds: t })
  }

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-col gap-5 sm:flex-row">
          <Cover name={m.current?.name} youtube={m.current?.youtube} className="size-28 shrink-0 self-center border border-iron-700 sm:size-36" />
          <div className="min-w-0 flex-1">
            <p className="font-display text-xl font-bold uppercase tracking-wide">{m.current?.name ?? 'KRATOS Player'}</p>
            <p className="mb-3 text-sm text-ash">{m.current ? `${m.queue.length} in queue${pl ? ` · ${pl.name}` : ''}` : 'Your music. Your session.'}</p>
            <Transport />
          </div>
        </div>
      </Card>
      {m.error && <Alert tone="error">{m.error}</Alert>}

      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        <Card title="Playlists">
          <ul className="space-y-1">
            {[{ id: 'all', name: 'All tracks', kind: null as PlaylistKind | null, n: m.tracks.length }, ...m.playlists.map((p) => ({ ...p, n: p.trackIds.length }))].map((p) => (
              <li key={p.id}>
                <button onClick={() => setSel(p.id)} aria-current={sel === p.id || undefined}
                  className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${sel === p.id ? 'bg-iron-800 text-bone' : 'text-ash hover:bg-iron-850 hover:text-bone'}`}>
                  <span className="truncate">{p.name}{p.kind && p.kind !== 'custom' && <span className="ml-2 text-[10px] uppercase tracking-wider text-accent">{KINDS[p.kind]}</span>}</span>
                  <span className="font-mono text-xs">{p.n}</span>
                </button>
              </li>
            ))}
          </ul>
          <form className="mt-4 space-y-2 border-t border-iron-800 pt-4" onSubmit={async (e) => {
            e.preventDefault()
            if (!newName.trim()) return
            const id = crypto.randomUUID()
            await m.savePlaylist({ id, name: newName.trim().slice(0, 60), kind: newKind, trackIds: [] })
            setNewName('')
            setSel(id)
          }}>
            <input aria-label="New playlist name" placeholder="New playlist" value={newName} maxLength={60} onChange={(e) => setNewName(e.target.value)} />
            <div className="flex flex-wrap gap-1.5">{(Object.keys(KINDS) as PlaylistKind[]).map((k) => <Chip key={k} on={newKind === k} onClick={() => setNewKind(k)}>{KINDS[k]}</Chip>)}</div>
            <Button variant="ghost" className="w-full" disabled={!newName.trim()}>Create playlist</Button>
          </form>
        </Card>

        <Card title={pl ? (
          <input aria-label="Playlist name" value={pl.name} maxLength={60} onChange={(e) => m.savePlaylist({ ...pl, name: e.target.value })}
            className="!w-auto border-transparent !bg-transparent !px-0 font-display text-sm uppercase tracking-[0.14em] text-bone" />
        ) : 'All tracks'} action={
          <div className="flex items-center gap-2">
            {ids.length > 0 && <Button onClick={() => m.play(ids, 0)}>Play</Button>}
            {pl && <Button variant="danger" onClick={() => { if (confirm(`Delete playlist “${pl.name}”? The tracks stay in your library.`)) { m.deletePlaylist(pl.id); setSel('all') } }}>Delete</Button>}
          </div>
        }>
          <form onSubmit={addLink} className="mb-3 flex gap-2">
            <input type="url" aria-label="YouTube link" placeholder="Paste a YouTube video or playlist link" value={link} onChange={(e) => setLink(e.target.value)} />
            <Button busy={busy && !!link} disabled={!link.trim()}>Add</Button>
          </form>
          {ytMsg && <div className="mb-3"><Alert tone="ok">{ytMsg}</Alert></div>}
          <label className={`relative mb-4 flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed border-iron-600 p-4 text-center text-sm hover:border-accent ${busy ? 'opacity-60' : ''}`}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFiles(e.dataTransfer.files) }}>
            <span className="font-semibold">{busy ? 'Importing…' : `Add audio files${pl ? ` to ${pl.name}` : ''}`}</span>
            <span className="text-xs text-ash">Drop files or click · MP3, M4A, WAV, OGG, FLAC (browser-dependent) · stored only in this browser</span>
            <input type="file" accept="audio/*" multiple className="sr-only left-0 top-0" disabled={busy} onChange={(e) => { onFiles(e.target.files); e.target.value = '' }} />
          </label>
          {errors.map((e) => <div key={e} className="mb-2"><Alert tone="error">{e}</Alert></div>)}

          {!ids.length ? <p className="py-8 text-center text-sm text-ash">{pl ? 'Empty playlist — add tracks from All tracks or drop files above.' : 'No music yet. Import audio files you own.'}</p> : (
            <ol className="divide-y divide-iron-800">
              {ids.map((id, i) => {
                const t = byId[id]
                const now = m.current?.id === id
                return (
                  <li key={`${id}-${i}`} className="flex items-center gap-3 py-2">
                    <button onClick={() => m.play(ids, i)} aria-label={`Play ${t.name}`} className={`w-6 font-mono text-xs ${now ? 'text-accent' : 'text-ash hover:text-bone'}`}>{now && m.playing ? '▶' : String(i + 1).padStart(2, '0')}</button>
                    <span className={`min-w-0 flex-1 truncate text-sm ${now ? 'text-accent' : ''}`}>
                      {t.youtube && <span className="mr-2 rounded bg-ember/15 px-1.5 py-0.5 text-[10px] font-bold text-ember">YT</span>}{t.name}
                    </span>
                    <span className="font-mono text-xs text-ash">{t.duration ? mmss(t.duration) : '—'}</span>
                    {pl ? (
                      <span className="flex gap-1 text-xs text-ash">
                        <button aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} className="px-1 hover:text-bone disabled:opacity-30">↑</button>
                        <button aria-label="Move down" disabled={i === ids.length - 1} onClick={() => move(i, 1)} className="px-1 hover:text-bone disabled:opacity-30">↓</button>
                        <button onClick={() => m.savePlaylist({ ...pl, trackIds: pl.trackIds.filter((_, j) => j !== pl.trackIds.indexOf(id)) })} className="px-1 hover:text-ember">Remove</button>
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        {m.playlists.length > 0 && (
                          <select aria-label={`Add ${t.name} to playlist`} value="" className="!w-28 !py-1 text-xs" onChange={(e) => {
                            const p = m.playlists.find((x) => x.id === e.target.value)
                            if (p) m.savePlaylist({ ...p, trackIds: [...p.trackIds, id] })
                          }}>
                            <option value="">Add to…</option>
                            {m.playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        )}
                        <button className="text-xs text-ash hover:text-ember" onClick={() => confirm(`Delete “${t.name}” from your library?`) && m.removeTrack(id)}>Delete</button>
                      </span>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
          <p className="mt-4 text-[11px] text-ash/80">Import only audio you own or have the right to use. YouTube links stream through YouTube’s own player (shown while it plays, as YouTube requires) and need internet; phones may pause them when the screen locks. Spotify and other services aren’t built in.</p>
        </Card>
      </div>
    </div>
  )
}
