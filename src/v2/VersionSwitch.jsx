/**
 * VersionSwitch.jsx — the v1 / v2 toggle shown in both headers.
 * Same pages, same data, same address; only the layout changes.
 */

import { useUiVersion } from './useUiVersion'
import './switch.css'

export default function VersionSwitch({ className = '' }) {
  const [version, setVersion] = useUiVersion()
  const btn = (v, label, title) => (
    <button
      type="button"
      onClick={() => setVersion(v)}
      title={title}
      aria-pressed={version === v}
      className={`v2-switch-btn ${version === v ? 'is-on' : ''}`}
    >
      {label}
    </button>
  )
  return (
    <div className={`v2-switch ${className}`} role="group" aria-label="Interface version">
      {btn('v1', 'v1', 'Current layout')}
      {btn('v2', 'v2', 'New workspace layout (preview)')}
    </div>
  )
}
