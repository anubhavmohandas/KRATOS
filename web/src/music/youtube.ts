// YouTube via the official IFrame Player API — streamed, never downloaded (YouTube's terms forbid
// extracting audio). The player must stay visible while playing, so it lives in a docked panel.

export type YTPlayer = {
  loadVideoById(id: string): void
  playVideo(): void
  pauseVideo(): void
  stopVideo(): void
  seekTo(s: number, allowSeekAhead: boolean): void
  setVolume(v: number): void
  getCurrentTime(): number
  getDuration(): number
  getPlayerState(): number
  cuePlaylist(o: { list: string; listType: 'playlist' }): void
  getPlaylist(): string[] | null
  destroy(): void
}
type YTNamespace = { Player: new (el: HTMLElement, opts: object) => YTPlayer }
declare global {
  interface Window { YT?: YTNamespace; onYouTubeIframeAPIReady?: () => void }
}

export const STATE = { ENDED: 0, PLAYING: 1, PAUSED: 2, CUED: 5 }
const ID = /^[A-Za-z0-9_-]{11}$/
const LIST = /^[A-Za-z0-9_-]{10,64}$/

/** Video and/or playlist id from any common YouTube URL shape (watch, youtu.be, shorts, embed, live, music). */
export function parseYouTube(input: string): { video?: string; list?: string } | null {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    return ID.test(input.trim()) ? { video: input.trim(), list: undefined } : null
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '')
  if (host !== 'youtube.com' && host !== 'youtu.be' && host !== 'youtube-nocookie.com') return null
  const path = u.pathname.split('/').filter(Boolean)
  const video = host === 'youtu.be' ? path[0] : ['shorts', 'embed', 'live', 'v'].includes(path[0]) ? path[1] : u.searchParams.get('v') ?? undefined
  const list = u.searchParams.get('list') ?? undefined
  const out = { video: video && ID.test(video) ? video : undefined, list: list && LIST.test(list) && !list.startsWith('RD') ? list : undefined } // RD… = auto-mixes, not real playlists
  return out.video || out.list ? out : null
}

let api: Promise<YTNamespace> | null = null
export function loadYouTube(): Promise<YTNamespace> {
  api ??= new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT)
    window.onYouTubeIframeAPIReady = () => resolve(window.YT!)
    const s = document.createElement('script')
    s.src = 'https://www.youtube.com/iframe_api'
    s.onerror = () => { api = null; reject(new Error('Couldn’t reach YouTube — check your connection.')) }
    document.head.appendChild(s)
  })
  return api
}

export function createPlayer(el: HTMLElement, events: Record<string, (e: { data: number; target: YTPlayer }) => void>): Promise<YTPlayer> {
  return loadYouTube().then((YT) => new Promise((resolve) => {
    new YT.Player(el, {
      width: '100%', height: '100%',
      playerVars: { playsinline: 1, rel: 0 },
      events: { ...events, onReady: (e: { target: YTPlayer }) => resolve(e.target) },
    })
  }))
}

/** Video ids in a public playlist, read by cueing it in a throwaway player (no API key needed). */
export async function playlistIds(list: string): Promise<string[]> {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-9999px;width:200px;height:200px'
  const inner = document.createElement('div')
  host.appendChild(inner)
  document.body.appendChild(host)
  try {
    const ids = await new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('YouTube didn’t return that playlist (private or deleted?).')), 15000)
      createPlayer(inner, {
        onStateChange: (e) => {
          const got = e.target.getPlaylist()
          if (e.data === STATE.CUED && got?.length) { clearTimeout(timer); resolve(got) }
        },
      }).then((p) => p.cuePlaylist({ list, listType: 'playlist' }), reject)
    })
    return ids.slice(0, 200)
  } finally {
    host.remove()
  }
}
