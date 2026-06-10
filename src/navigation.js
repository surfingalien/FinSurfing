/**
 * navigation.js
 *
 * Single source of truth for app navigation.
 * Consumed by Sidebar (rendering), CommandPalette (search) and
 * useHashRoute (route validation) so tabs can never drift apart.
 */

import {
  LayoutDashboard, PieChart, Eye, LineChart, Lightbulb,
  TrendingUp, SlidersHorizontal, GitBranch, Bell, Bot,
  ShieldCheck, Activity, FlaskConical, BarChart3, Sparkles,
  Brain, Bookmark, Monitor, BookOpen, Globe, Target,
  Network, Clock, Radio, BrainCircuit, FolderOpen,
} from 'lucide-react'

// ── Sidebar nav groups ────────────────────────────────────────────────────────
export const NAV_GROUPS = [
  {
    label: 'Overview',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { id: 'portfolio', label: 'Portfolio', icon: PieChart },
      { id: 'watchlist', label: 'Watchlist', icon: Eye },
      { id: 'alerts',    label: 'Alerts',    icon: Bell },
    ],
  },
  {
    label: 'Markets',
    items: [
      { id: 'analyze',     label: 'Analyze',     icon: LineChart },
      { id: 'tradingview', label: 'TradingView', icon: Monitor },
    ],
  },
  {
    label: 'AI Tools',
    items: [
      { id: 'market-focus',    label: 'Market Focus',   icon: Radio, tag: 'LIVE' },
      { id: 'ai-brain',        label: 'AI Brain',       icon: Brain },
      { id: 'buy-signals',     label: 'AI Buy Signals', icon: Sparkles },
      { id: 'ai-watchlist',    label: 'AI Watchlist',   icon: Bookmark },
      { id: 'agent-hub',       label: 'Agent Hub',      icon: Network },
      { id: 'agentic-os',      label: 'Agentic OS',     icon: BrainCircuit },
      { id: 'trade-timeline',  label: 'Trade Timeline', icon: Clock },
      { id: 'research',        label: 'AI Agent',       icon: Bot },
      { id: 'second-brain',    label: 'Second Brain',   icon: BookOpen },
      { id: 'quantmind',       label: 'QuantMind',      icon: FlaskConical },
      { id: 'recommendations', label: 'Advisory',       icon: Lightbulb },
      { id: 'macro',           label: 'Macro',          icon: Globe },
      { id: 'polymarket',      label: 'Polymarket',     icon: TrendingUp },
    ],
  },
  {
    label: 'Strategies',
    items: [
      { id: 'strategies', label: 'Strategies', icon: GitBranch },
      { id: 'backtest',   label: 'Backtester', icon: FlaskConical },
    ],
  },
  {
    label: 'Planning',
    items: [
      { id: 'goals',        label: 'Goals',          icon: Target },
      { id: 'analytics',    label: 'Risk Analytics', icon: Activity },
      { id: 'risk-rules',   label: 'Risk Rules',     icon: ShieldCheck },
      { id: 'trade-setups', label: 'Trade Setups',   icon: SlidersHorizontal },
      { id: 'montecarlo',   label: 'Retirement',     icon: TrendingUp },
      { id: 'rebalancer',   label: 'AI Rebalancer',  icon: BarChart3 },
    ],
  },
]

export const ADMIN_GROUP = {
  label: 'Admin',
  items: [{ id: 'admin', label: 'Admin', icon: ShieldCheck, admin: true }],
}

// Tabs reachable outside the sidebar groups (user menu, deep links)
const EXTRA_TABS = ['portfolios', 'admin']

// ── All valid route tabs ──────────────────────────────────────────────────────
export const ALL_TABS = new Set([
  ...NAV_GROUPS.flatMap(g => g.items.map(i => i.id)),
  ...EXTRA_TABS,
])

// Flat command list for the palette: [{ id, label, icon, group }]
// Includes routes reachable outside the sidebar groups (admin stays hidden —
// it's role-gated and the route itself rejects non-admins)
export const NAV_COMMANDS = [
  ...NAV_GROUPS.flatMap(g => g.items.map(i => ({ ...i, group: g.label }))),
  { id: 'portfolios', label: 'Manage Portfolios', icon: FolderOpen, group: 'Account' },
]
