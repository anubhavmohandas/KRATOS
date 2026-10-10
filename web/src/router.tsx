import { useEffect, useState, type AnchorHTMLAttributes } from 'react'

// Real paths (/train/library) on the History API — no router dependency. The API serves
// index.html for any non-/api path, so deep links and refreshes work.

export function navigate(to: string, replace = false) {
  if (to === location.pathname) return
  history[replace ? 'replaceState' : 'pushState'](null, '', to)
  dispatchEvent(new PopStateEvent('popstate'))
  if (!replace) scrollTo(0, 0)
}

export function usePath() {
  const [path, setPath] = useState(location.pathname)
  useEffect(() => {
    const f = () => setPath(location.pathname)
    addEventListener('popstate', f)
    return () => removeEventListener('popstate', f)
  }, [])
  return path
}

/** <a> that navigates in-app; modified clicks (new tab, etc.) keep native behaviour. */
export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a href={href} {...rest} onClick={(e) => {
      onClick?.(e)
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      e.preventDefault()
      navigate(href)
    }} />
  )
}
