// Your audio files live in this browser's IndexedDB — nothing is uploaded, and it works offline.

/** A local file (`data` + `mime`; older tracks kept the File as `blob`) or a YouTube video (`youtube` = id, streamed by the embedded player). */
export type Track = { id: string; name: string; duration: number; added: number; data?: ArrayBuffer; mime?: string; blob?: Blob; youtube?: string }

/** The track's audio. Stored as an ArrayBuffer because Safari's IndexedDB refuses Blobs in private windows. */
export const audioOf = (t: Track) => t.blob ?? new Blob([t.data!], { type: t.mime })
export type PlaylistKind = 'warmup' | 'strength' | 'cardio' | 'cooldown' | 'custom'
export type Playlist = { id: string; name: string; kind: PlaylistKind; trackIds: string[] }
type Store = 'tracks' | 'playlists'

let conn: Promise<IDBDatabase> | null = null
function open() {
  conn ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('kratos-music', 1)
    r.onupgradeneeded = () => {
      r.result.createObjectStore('tracks', { keyPath: 'id' })
      r.result.createObjectStore('playlists', { keyPath: 'id' })
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => { conn = null; reject(r.error) }
  })
  return conn
}

async function req<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await open()
  return new Promise((resolve, reject) => {
    const r = fn(d.transaction(store, mode).objectStore(store))
    r.onsuccess = () => resolve(r.result as T)
    r.onerror = () => reject(r.error)
  })
}

export const db = {
  all: <T>(store: Store) => req<T[]>(store, 'readonly', (s) => s.getAll()),
  put: (store: Store, value: Track | Playlist) => req(store, 'readwrite', (s) => s.put(value)),
  del: (store: Store, id: string) => req(store, 'readwrite', (s) => s.delete(id)),
}

const MAX_BYTES = 200 * 1024 * 1024

/** Reads duration with a throwaway <audio>; rejects files the browser can't decode. */
export function toTrack(file: File): Promise<Track> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('audio/')) return reject(new Error(`${file.name}: not an audio file`))
    if (file.size > MAX_BYTES) return reject(new Error(`${file.name}: larger than 200 MB`))
    const url = URL.createObjectURL(file)
    const a = new Audio()
    const done = (err?: string) => {
      URL.revokeObjectURL(url)
      if (err) return reject(new Error(`${file.name}: ${err}`))
      file.arrayBuffer().then((data) => resolve({
        id: crypto.randomUUID(), name: file.name.replace(/\.[^.]+$/, ''), duration: a.duration || 0, added: Date.now(), data, mime: file.type,
      }), () => reject(new Error(`${file.name}: couldn’t read the file`)))
    }
    a.preload = 'metadata'
    a.onloadedmetadata = () => done()
    a.onerror = () => done('this browser can’t play that format')
    a.src = url
  })
}
