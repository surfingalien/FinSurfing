/**
 * Connections — what the app is configured to talk to, and which AI circuit
 * breakers have tripped.
 *
 * "Key set" is configuration, not proof: a key can be set and rejected. The live
 * test is the Research Desk's "Is it working?" check, linked below, so this page
 * never claims a provider is "connected" or "working".
 */
import { ArrowRight, RotateCcw, Stethoscope } from 'lucide-react'
import { Section, Chip, Note, Empty, btn, btnQuiet, relTime, exact } from './ui'

// Missing these matters; every other missing key is a documented optional fallback.
const MATTERS_IF_MISSING = new Set(['claude', 'groq', 'postgres', 'persistence'])
const STATE = {
  set:     { label: 'Key set',        tone: () => 'ok' },
  keyless: { label: 'No key needed',  tone: () => 'neutral' },
  paused:  { label: 'Paused',         tone: () => 'warn' },
  missing: { label: 'Not set',        tone: (id) => (MATTERS_IF_MISSING.has(id) ? 'warn' : 'neutral') },
}
const BREAKER = { CLOSED: { label: 'Closed', tone: 'ok' }, HALF_OPEN: { label: 'Testing', tone: 'warn' }, OPEN: { label: 'Open', tone: 'bad' } }

export default function ConnectionsTab({ data, isAdmin, act, busy, go }) {
  const { groups, breakers } = data.connections
  return (
    <div className="space-y-4">
      <Note>
        “Key set” means the app is configured for a service, not that the service is accepting it. For a live test of the data feed, AI providers, FRED and FMP, run <button type="button" className={btnQuiet} onClick={() => go({ tab: 'research-desk' })}>“Is it working?” on the Research Desk</button>.
      </Note>

      <div className="lg:columns-2 lg:gap-4">
        {groups.map(g => (
          <Section key={g.id} title={g.label} className="mb-4 break-inside-avoid">
            <ul className="divide-y divide-slate-500/10 -my-1">
              {g.items.map(i => {
                const st = STATE[i.state] || STATE.missing
                return (
                  <li key={i.id} className="flex items-start justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm text-white">{i.label}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{i.role}</p>
                      {(i.state === 'missing' || i.state === 'paused') && <p className={`text-[11px] mt-0.5 ${st.tone(i.id) === 'warn' ? 'text-amber-300' : 'text-slate-600'}`}>{i.note}</p>}
                    </div>
                    <Chip tone={st.tone(i.id)}>{st.label}</Chip>
                  </li>
                )
              })}
            </ul>
          </Section>
        ))}
      </div>

      <Section title="AI circuit breakers" sub="A breaker opens after repeated failures so the app stops hammering a failing provider, then retries on its own.">
        {!breakers.length ? (
          <Empty icon={Stethoscope}>No breaker has been created yet. They appear after the first AI call and stay closed while calls succeed.</Empty>
        ) : (
          <ul className="divide-y divide-slate-500/10 -my-1">
            {breakers.map(b => {
              const st = BREAKER[b.state] || BREAKER.CLOSED
              return (
                <li key={b.name} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm text-white font-mono">{b.name}</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {b.failures}/{b.threshold} failures in a row · {b.totalFailures} of {b.totalCalls} calls failed
                      {b.lastFailureAt ? <> · last failure <span title={exact(b.lastFailureAt)}>{relTime(b.lastFailureAt)}</span></> : null}
                      {b.state === 'OPEN' && b.resetInMs != null ? ` · retries in ${Math.ceil(b.resetInMs / 1000)}s` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Chip tone={st.tone}>{st.label}</Chip>
                    {isAdmin && b.state !== 'CLOSED' && (
                      <button type="button" className={btn} disabled={!!busy} onClick={() => act(`breaker:${b.name}`, `/api/governance/circuit-reset/${encodeURIComponent(b.name)}`)}>
                        <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />Reset
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {isAdmin && <button type="button" className={`${btnQuiet} mt-3`} onClick={() => go({ tab: 'admin' })}>AI audit log &amp; kill switches (Admin)<ArrowRight className="w-3 h-3" aria-hidden="true" /></button>}
      </Section>
    </div>
  )
}
