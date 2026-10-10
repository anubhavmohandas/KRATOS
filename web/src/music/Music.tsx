import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { db, toTrack, type Playlist, type Track } from './db'
import { Link } from '../router'
import { api } from '../api'
import { createPlayer, parseYouTube, playlistIds, STATE, type YTPlayer } from './youtube'

type Repeat = 'off' | 'all' | 'one'
type Ctx = {
  tracks: Track[]
  playlists: Playlist[]
  queue: string[]
  current: Track | null
  playing: boolean
  pos: number
  dur: number
  shuffle: boolean
  repeat: Repeat
  volume: number
  error: string
  play: (queue: string[], index?: number) => void
  toggle: () => void
  next: () => void
  prev: () => void
  seek: (secs: number) => void
  setVolume: (v: number) => void
  setShuffle: (v: boolean) => void
  cycleRepeat: () => void
  importFiles: (files: FileList | File[], playlistId?: string) => Promise<string[]>
  removeTrack: (id: string) => Promise<void>
  savePlaylist: (p: Playlist) => Promise<void>
  deletePlaylist: (id: string) => Promise<void>
  addYouTube: (url: string, playlistId?: string) => Promise<{ added: number; playlistId?: string; error?: string }>
  stop: () => void
}

const MusicCtx = createContext<Ctx>(null!)
export const useMusic = () => useContext(MusicCtx)

const pref = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d } catch { return d } }
const setPref = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* not persisted */ } }

/** One <audio> + one YouTube player for the whole app, so music keeps playing across pages and during workouts. */
export function MusicProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement>(null!)
  audio.current ??= new Audio()
  const url = useRef('')
  const [tracks, setTracks] = useState<Track[]>([])
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [queue, setQueue] = useState<string[]>([])
  const [index, setIndex] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [dur, setDur] = useState(0)
  const [shuffle, setShuffleS] = useState(pref('kratos.shuffle', '0') === '1')
  const [repeat, setRepeat] = useState<Repeat>(pref('kratos.repeat', 'all') as Repeat)
  const [volume, setVolumeS] = useState(+pref('kratos.musicVolume', '0.8'))
  const [error, setError] = useState('')
  const current = tracks.find((t) => t.id === queue[index]) ?? null
  // Media/ended handlers are bound once, so they read live state through this ref.
  const state = useRef({ queue, index, shuffle, repeat, tracks, volume })
  state.current = { queue, index, shuffle, repeat, tracks, volume }
  const isYT = !!current?.youtube
  const ytHost = useRef<HTMLDivElement>(null)
  const yt = useRef<Promise<YTPlayer> | null>(null)
  const ytNow = useRef<YTPlayer | null>(null) // resolved player, for synchronous controls

  function getYT() {
    if (!yt.current) {
      const inner = document.createElement('div') // YouTube replaces this node with its iframe; React never owns it
      ytHost.current!.appendChild(inner)
      yt.current = createPlayer(inner, {
        onStateChange: (e) => {
          if (e.data === STATE.PLAYING) setPlaying(true)
          else if (e.data === STATE.PAUSED) setPlaying(false)
          else if (e.data === STATE.ENDED) step(1, true)
        },
        onError: (e) => {
          setError(e.data === 101 || e.data === 150 ? 'That video’s owner blocks playback outside YouTube — skipped.' : 'YouTube couldn’t play that video — skipped.')
          if (state.current.queue.length > 1) step(1)
          else setPlaying(false)
        },
      }).then((p) => (ytNow.current = p), (e) => {
        yt.current = null
        inner.remove()
        throw e
      })
    }
    return yt.current
  }

  useEffect(() => {
    Promise.all([db.all<Track>('tracks'), db.all<Playlist>('playlists')])
      .then(([t, p]) => { setTracks(t.sort((a, b) => a.added - b.added)); setPlaylists(p) })
      .catch(() => setError('Music storage is unavailable in this browser (private mode?).'))
  }, [])

  function step(dir: 1 | -1, auto = false) {
    const { queue: q, index: i, shuffle: sh, repeat: rp } = state.current
    if (!q.length) return
    if (auto && rp === 'one') return load(q, i)
    let n = sh && q.length > 1 ? (i + 1 + Math.floor(Math.random() * (q.length - 1))) % q.length : i + dir
    if (n >= q.length || n < 0) {
      if (auto && rp === 'off') return setPlaying(false)
      n = (n + q.length) % q.length
    }
    load(q, n)
  }

  useEffect(() => {
    const a = audio.current
    a.volume = volume
    const on: Record<string, () => void> = {
      timeupdate: () => setPos(a.currentTime),
      loadedmetadata: () => setDur(a.duration || 0),
      play: () => setPlaying(true),
      pause: () => setPlaying(false),
      ended: () => step(1, true),
      error: () => setError('Couldn’t play that track.'),
    }
    for (const [k, f] of Object.entries(on)) a.addEventListener(k, f)
    const ms = navigator.mediaSession
    ms?.setActionHandler('play', () => live.current.playing || live.current.toggle())
    ms?.setActionHandler('pause', () => live.current.playing && live.current.toggle())
    ms?.setActionHandler('nexttrack', () => step(1))
    ms?.setActionHandler('previoustrack', () => step(-1))
    ms?.setActionHandler('seekto', (d) => { if (d.seekTime != null) live.current.seek(d.seekTime) })
    return () => { for (const [k, f] of Object.entries(on)) a.removeEventListener(k, f) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // YouTube has no timeupdate event — poll while playing; remember the duration once it's known.
  useEffect(() => {
    if (!isYT || !playing) return
    const t = setInterval(() => {
      const p = ytNow.current
      if (p) { setPos(p.getCurrentTime()); setDur(p.getDuration()) }
    }, 500)
    return () => clearInterval(t)
  }, [isYT, playing])
  useEffect(() => {
    if (!current?.youtube || !dur || current.duration) return
    const t = { ...current, duration: dur }
    db.put('tracks', t).catch(() => {})
    setTracks((all) => all.map((x) => (x.id === t.id ? t : x)))
  }, [dur]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (current && 'mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: current.name, artist: 'KRATOS', album: 'Training' })
  }, [current])

  function load(q: string[], i: number) {
    const t = state.current.tracks.find((x) => x.id === q[i])
    if (!t) return
    setError('')
    setQueue(q)
    setIndex(i)
    setPos(0)
    setDur(t.duration)
    if (t.youtube) {
      audio.current.pause()
      getYT().then((p) => { p.setVolume(state.current.volume * 100); p.loadVideoById(t.youtube!) }, (e) => setError((e as Error).message))
      return
    }
    ytNow.current?.stopVideo()
    if (url.current) URL.revokeObjectURL(url.current)
    url.current = URL.createObjectURL(t.blob!)
    audio.current.src = url.current
    audio.current.play().catch(() => setPlaying(false))
  }

  const now = () => (isYT ? ytNow.current?.getCurrentTime() ?? 0 : audio.current.currentTime)

  /** Titles via the API's oEmbed lookup, 6 at a time; blank on failure. */
  async function titles(ids: string[]) {
    const out: string[] = []
    for (let i = 0; i < ids.length; i += 6)
      out.push(...await Promise.all(ids.slice(i, i + 6).map((id) => api.get<{ title: string }>(`/youtube/title?id=${id}`).then((r) => r.title, () => ''))))
    return out
  }

  const ctx: Ctx = {
    tracks, playlists, queue, current, playing, pos, dur, shuffle, repeat, volume, error,
    play: (q, i = 0) => load(q, i),
    toggle: () => {
      if (!current) return tracks.length ? load(tracks.map((t) => t.id), 0) : undefined
      if (isYT) {
        const p = ytNow.current
        if (p) p.getPlayerState() === STATE.PLAYING ? p.pauseVideo() : p.playVideo()
      } else if (audio.current.paused) audio.current.play().catch(() => {})
      else audio.current.pause()
    },
    next: () => step(1),
    prev: () => {
      if (now() > 3) ctx.seek(0) // first press restarts the track
      else step(-1)
    },
    seek: (s) => {
      if (isYT) ytNow.current?.seekTo(s, true)
      else audio.current.currentTime = s
      setPos(s)
    },
    setVolume: (v) => { audio.current.volume = v; ytNow.current?.setVolume(v * 100); setVolumeS(v); setPref('kratos.musicVolume', String(v)) },
    setShuffle: (v) => { setShuffleS(v); setPref('kratos.shuffle', v ? '1' : '0') },
    cycleRepeat: () => setRepeat((r) => { const n = r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'; setPref('kratos.repeat', n); return n }),
    importFiles: async (files, playlistId) => {
      const errors: string[] = []
      const added: Track[] = []
      for (const f of Array.from(files)) {
        try {
          const t = await toTrack(f)
          await db.put('tracks', t)
          added.push(t)
        } catch (e) {
          errors.push((e as Error).message)
        }
      }
      setTracks((t) => [...t, ...added])
      const pl = playlists.find((p) => p.id === playlistId)
      if (pl && added.length) await ctx.savePlaylist({ ...pl, trackIds: [...pl.trackIds, ...added.map((t) => t.id)] })
      return errors
    },
    removeTrack: async (id) => {
      await db.del('tracks', id)
      setTracks((t) => t.filter((x) => x.id !== id))
      for (const p of playlists) if (p.trackIds.includes(id)) await ctx.savePlaylist({ ...p, trackIds: p.trackIds.filter((x) => x !== id) })
    },
    savePlaylist: async (p) => {
      await db.put('playlists', p)
      setPlaylists((all) => (all.some((x) => x.id === p.id) ? all.map((x) => (x.id === p.id ? p : x)) : [...all, p]))
    },
    deletePlaylist: async (id) => {
      await db.del('playlists', id)
      setPlaylists((all) => all.filter((x) => x.id !== id))
    },
    addYouTube: async (link, playlistId) => {
      const parsed = parseYouTube(link)
      if (!parsed) return { added: 0, error: 'That isn’t a YouTube video or playlist link.' }
      let ids = parsed.video ? [parsed.video] : []
      let fromList = false
      if (parsed.list) {
        try {
          ids = await playlistIds(parsed.list)
          fromList = true
        } catch (e) {
          if (!ids.length) return { added: 0, error: (e as Error).message }
        }
      }
      const known = new Map(tracks.filter((t) => t.youtube).map((t) => [t.youtube!, t.id]))
      const fresh = [...new Set(ids.filter((id) => !known.has(id)))]
      const names = await titles(fresh)
      const added: Track[] = fresh.map((id, k) => ({ id: crypto.randomUUID(), name: names[k] || `YouTube video ${id}`, duration: 0, added: Date.now() + k, youtube: id }))
      for (const t of added) await db.put('tracks', t)
      setTracks((all) => [...all, ...added])
      for (const t of added) known.set(t.youtube!, t.id)
      let target = playlists.find((p) => p.id === playlistId)
      if (!target && fromList) target = { id: crypto.randomUUID(), name: 'YouTube playlist', kind: 'custom', trackIds: [] }
      if (target) await ctx.savePlaylist({ ...target, trackIds: [...target.trackIds, ...ids.map((id) => known.get(id)!)] })
      return { added: ids.length, playlistId: target?.id }
    },
    stop: () => {
      audio.current.pause()
      ytNow.current?.stopVideo()
      setPlaying(false)
      setQueue([])
      setIndex(-1)
    },
  }
  const live = useRef(ctx)
  live.current = ctx

  return (
    <MusicCtx.Provider value={ctx}>
      {children}
      {/* YouTube's terms require a visible player while it plays — docked, never hidden mid-playback. */}
      <div role="region" aria-label="YouTube player"
        className={`fixed bottom-40 right-20 z-30 w-[min(360px,calc(100vw-6rem))] overflow-hidden rounded-xl border border-iron-700 bg-black shadow-2xl shadow-black lg:bottom-6 lg:right-24 ${isYT ? '' : 'hidden'}`}>
        <div className="flex items-center gap-2 bg-iron-900 px-3 py-1.5 text-xs">
          <span className="font-semibold text-ember">YouTube</span>
          <span className="min-w-0 flex-1 truncate text-ash">{current?.name}</span>
          <button onClick={ctx.stop} aria-label="Stop and close YouTube player" className="px-1 text-base leading-none text-ash hover:text-bone">×</button>
        </div>
        <div ref={ytHost} className="h-[200px] w-full [&>*]:h-full [&>*]:w-full" />
      </div>
    </MusicCtx.Provider>
  )
}

export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** Generated cover: lime waveform on graphite, seeded by the track name. */
export function Cover({ name = 'KRATOS', youtube, className = '' }: { name?: string; youtube?: string; className?: string }) {
  if (youtube) return <img src={`https://i.ytimg.com/vi/${youtube}/mqdefault.jpg`} alt="" className={`rounded-lg object-cover ${className}`} />
  const seed = [...name].reduce((s, c) => (s * 31 + c.charCodeAt(0)) % 997, 7)
  const wave = (k: number, amp: number) => Array.from({ length: 41 }, (_, i) => {
    const x = i * 2.5
    const env = Math.exp(-((x - 50) ** 2) / 500)
    return `${x},${50 + Math.sin(i * (0.6 + (seed % 7) / 20) + k) * amp * env}`
  }).join(' ')
  return (
    <svg viewBox="0 0 100 100" className={`rounded-lg bg-iron-950 ${className}`} aria-hidden>
      <polyline points={wave(0, 34)} fill="none" stroke="var(--color-accent)" strokeWidth="1.6" />
      <polyline points={wave(1.7, 22)} fill="none" stroke="var(--color-iron-600)" strokeWidth="1.2" />
      <polyline points={wave(3.1, 14)} fill="none" stroke="var(--color-accent)" strokeOpacity=".45" strokeWidth="1" />
    </svg>
  )
}

const I = {
  play: 'M8 5v14l11-7z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  next: 'M6 5l9 7-9 7zM17 5h2v14h-2z',
  prev: 'M18 5l-9 7 9 7zM5 5h2v14H5z',
  shuffle: 'M4 7h3l10 10h3M4 17h3l10-10h3M17 4l3 3-3 3M17 14l3 3-3 3',
  repeat: 'M4 12V9a3 3 0 0 1 3-3h12l-3-3M20 12v3a3 3 0 0 1-3 3H5l3 3',
}
export function Icon({ d, fill = false, className = 'size-5' }: { d: string; fill?: boolean; className?: string }) {
  return <svg viewBox="0 0 24 24" className={className} fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
}

/** Full transport: seek, shuffle, prev, play, next, repeat, volume. */
export function Transport() {
  const m = useMusic()
  const btn = 'grid size-10 place-items-center rounded-full text-ash transition-colors hover:text-bone disabled:opacity-40'
  return (
    <div>
      <input type="range" aria-label="Seek" min={0} max={m.dur || 0} step={0.1} value={Math.min(m.pos, m.dur || 0)} disabled={!m.current}
        onChange={(e) => m.seek(+e.target.value)} className="!border-0 !bg-transparent !px-0 accent-accent" />
      <div className="flex justify-between font-mono text-xs text-ash"><span>{mmss(m.pos)}</span><span>{mmss(m.dur)}</span></div>
      <div className="mt-2 flex items-center justify-between">
        <button className={`${btn} ${m.shuffle ? '!text-accent' : ''}`} aria-pressed={m.shuffle} aria-label="Shuffle" onClick={() => m.setShuffle(!m.shuffle)}><Icon d={I.shuffle} /></button>
        <button className={btn} aria-label="Previous" disabled={!m.current} onClick={m.prev}><Icon d={I.prev} fill /></button>
        <button className="grid size-16 place-items-center rounded-full bg-bone text-iron-950 transition-transform hover:scale-105 disabled:opacity-40" disabled={!m.tracks.length}
          aria-label={m.playing ? 'Pause' : 'Play'} onClick={m.toggle}><Icon d={m.playing ? I.pause : I.play} fill className="size-7" /></button>
        <button className={btn} aria-label="Next" disabled={!m.current} onClick={m.next}><Icon d={I.next} fill /></button>
        <button className={`${btn} relative ${m.repeat !== 'off' ? '!text-accent' : ''}`} aria-label={`Repeat: ${m.repeat}`} onClick={m.cycleRepeat}>
          <Icon d={I.repeat} />{m.repeat === 'one' && <span className="absolute right-1 top-1 text-[9px] font-bold">1</span>}
        </button>
      </div>
      <label className="mt-3 flex items-center gap-3 text-xs text-ash">Volume
        <input type="range" min={0} max={1} step={0.05} value={m.volume} onChange={(e) => m.setVolume(+e.target.value)} className="!border-0 !bg-transparent !px-0 accent-accent" />
      </label>
    </div>
  )
}

/** Docked player: visible on every page once something is loaded. */
export function MiniPlayer() {
  const m = useMusic()
  if (!m.current) return null
  return (
    <div className="flex items-center gap-3 rounded-xl border border-iron-700 bg-iron-900/95 p-2 pr-3 backdrop-blur">
      <Link href="/space/music" aria-label="Open player"><Cover name={m.current.name} youtube={m.current.youtube} className="size-10 shrink-0" /></Link>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{m.current.name}</div>
        <div className="mt-1 h-1 overflow-hidden rounded bg-iron-700"><div className="h-full bg-accent" style={{ width: `${m.dur ? (m.pos / m.dur) * 100 : 0}%` }} /></div>
      </div>
      <button aria-label={m.playing ? 'Pause' : 'Play'} onClick={m.toggle} className="grid size-9 place-items-center rounded-full bg-bone text-iron-950"><Icon d={m.playing ? I.pause : I.play} fill className="size-4" /></button>
      <button aria-label="Next" onClick={m.next} className="text-ash hover:text-bone"><Icon d={I.next} fill className="size-4" /></button>
    </div>
  )
}
