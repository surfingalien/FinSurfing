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
  Search, DollarSign, LayoutGrid, CalendarDays, Zap, FileText, Boxes, Mountain,
  Share2,
  Filter, Microscope,
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
      { id: 'analyze',      label: 'Analyze',       icon: LineChart    },
      { id: 'market-focus', label: 'Market Focus',  icon: Radio, tag: 'LIVE' },
      { id: 'tradingview',  label: 'TradingView',   icon: Monitor      },
      { id: 'heatmap',      label: 'Heatmap',       icon: LayoutGrid   },
      { id: 'calendar',     label: 'Econ Calendar', icon: CalendarDays },
      { id: 'sentiment',    label: 'Sentiment',     icon: Zap          },
      { id: 'macro',        label: 'Macro',         icon: Globe        },
    ],
  },
  // The research application: find candidates, gather evidence, form and check
  // a thesis. The Research Desk runs that whole flow for one symbol; the rest
  // are the specialised instruments it draws on.
  {
    label: 'Research',
    items: [
      { id: 'research-desk',   label: 'Research Desk',   icon: Microscope, tag: 'NEW' },
      { id: 'screener',        label: 'Screener',        icon: Filter },
      { id: 'ai-brain',        label: 'AI Brain Scan',   icon: Brain },
      { id: 'recommendations', label: 'Advisory',        icon: Lightbulb },
      { id: 'buy-signals',     label: 'AI Buy Signals',  icon: Sparkles },
      { id: 'filings',         label: 'Filing Research', icon: FileText },
      { id: 'exposure',        label: 'Exposure Map',    icon: Network },
      { id: 'dcf-valuation',   label: 'DCF Valuation',   icon: TrendingUp },
      { id: 'pattern-finder',  label: 'Pattern Finder',  icon: Search },
      { id: 'dividend-screen', label: 'Dividend Screen', icon: DollarSign },
    ],
  },
  // What the AI actually got right, measured against the market.
  {
    label: 'Track Record',
    items: [
      { id: 'brain-activity',      label: 'Brain Activity',      icon: Activity },
      { id: 'trade-timeline',      label: 'Trade Timeline',      icon: Clock },
      { id: 'probability-lattice', label: 'Probability Lattice', icon: Boxes },
    ],
  },
  {
    label: 'Agents & Labs',
    items: [
      { id: 'research',     label: 'AI Agent',     icon: Bot },
      { id: 'agent-hub',    label: 'Agent Hub',    icon: Network },
      { id: 'agentic-os',   label: 'Agentic OS',   icon: BrainCircuit },
      { id: 'second-brain', label: 'Second Brain', icon: BookOpen },
      { id: 'quantmind',    label: 'QuantMind',    icon: FlaskConical },
      { id: 'ai-watchlist', label: 'AI Watchlist', icon: Bookmark },
      { id: 'polymarket',   label: 'Polymarket',   icon: TrendingUp },
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
      { id: 'tail-ridge',   label: 'Tail Probability Ridge', icon: Mountain },
      { id: 'relationship-graph', label: 'Relationship Graph', icon: Share2 },
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
