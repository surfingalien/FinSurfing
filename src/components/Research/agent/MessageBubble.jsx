import { ChevronRight, Cpu } from 'lucide-react'
import { ToolCallBadge } from './ToolCallBadge'

// ── Markdown-lite renderer ────────────────────────────────────────────────────
// Renders the structured sections Claude outputs without a full MD library

function renderMarkdown(text) {
  if (!text) return null

  const lines = text.split('\n')
  const elements = []
  let key = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Bold header **Executive Summary** etc.
    if (/^\*\*(.+)\*\*$/.test(line.trim())) {
      elements.push(
        <h3 key={key++} className="text-sm font-bold text-mint-400 mt-4 mb-1 flex items-center gap-1.5">
          <ChevronRight className="w-3 h-3" />
          {line.trim().replace(/\*\*/g, '')}
        </h3>
      )
      continue
    }

    // Bullet points
    if (/^[-•*]\s/.test(line.trim())) {
      const content = line.trim().replace(/^[-•*]\s/, '')
      elements.push(
        <div key={key++} className="flex items-start gap-2 text-sm text-slate-300 my-0.5 ml-3">
          <span className="text-mint-500 mt-1.5 shrink-0">·</span>
          <span dangerouslySetInnerHTML={{ __html: formatInline(content) }} />
        </div>
      )
      continue
    }

    // Numbered list
    if (/^\d+\.\s/.test(line.trim())) {
      const content = line.trim().replace(/^\d+\.\s/, '')
      const num = line.trim().match(/^(\d+)\./)[1]
      elements.push(
        <div key={key++} className="flex items-start gap-2 text-sm text-slate-300 my-0.5 ml-3">
          <span className="text-mint-500 shrink-0 font-mono text-xs mt-0.5">{num}.</span>
          <span dangerouslySetInnerHTML={{ __html: formatInline(content) }} />
        </div>
      )
      continue
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      elements.push(<hr key={key++} className="border-white/[0.06] my-3" />)
      continue
    }

    // Empty line
    if (!line.trim()) {
      elements.push(<div key={key++} className="h-1" />)
      continue
    }

    // Normal paragraph
    elements.push(
      <p key={key++} className="text-sm text-slate-300 leading-relaxed my-0.5"
        dangerouslySetInnerHTML={{ __html: formatInline(line) }} />
    )
  }

  return elements
}

function formatInline(text) {
  return text
    // **bold**
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-white font-semibold">$1</strong>')
    // *italic*
    .replace(/\*(.+?)\*/g, '<em class="text-slate-200">$1</em>')
    // `code`
    .replace(/`([^`]+)`/g, '<code class="font-mono text-xs bg-white/10 px-1.5 py-0.5 rounded text-mint-300">$1</code>')
    // $price highlights
    .replace(/\$(\d[\d,.]+)/g, '<span class="font-mono text-emerald-300">$$1</span>')
}

// ── Message bubble ────────────────────────────────────────────────────────────

export function MessageBubble({ msg }) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-mint-500/10 border border-mint-500/20 rounded-2xl rounded-tr-sm px-4 py-2.5">
          <p className="text-sm text-white">{msg.content}</p>
        </div>
      </div>
    )
  }

  // Assistant message
  return (
    <div className="flex gap-3 max-w-[95%]">
      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-mint-400/20 to-indigo-500/20 border border-mint-500/30 flex items-center justify-center shrink-0 mt-0.5">
        <Cpu className="w-3.5 h-3.5 text-mint-400" />
      </div>
      <div className="flex-1 space-y-2">
        {/* Tool calls */}
        {msg.toolCalls?.map((tc, i) => (
          <ToolCallBadge key={i} name={tc.name} input={tc.input} done={tc.done} />
        ))}

        {/* Text content */}
        {msg.content && (
          <div className="glass rounded-2xl rounded-tl-sm px-4 py-3 border border-white/[0.06]">
            {renderMarkdown(msg.content)}
          </div>
        )}

        {/* Streaming cursor */}
        {msg.streaming && (
          <div className="flex items-center gap-1.5 px-2">
            <div className="w-1.5 h-1.5 rounded-full bg-mint-400 animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-mint-400 animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-mint-400 animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        )}

        {/* Usage */}
        {msg.usage && (
          <div className="text-[10px] text-slate-700 px-1">
            {msg.usage.input_tokens}↑ {msg.usage.output_tokens}↓ tokens
          </div>
        )}
      </div>
    </div>
  )
}
