import * as RadixTooltip from '@radix-ui/react-tooltip'

export function TooltipProvider({ children }) {
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={100}>
      {children}
    </RadixTooltip.Provider>
  )
}

export function Tooltip({ children, content, side = 'top' }) {
  if (!content) return children
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={5}
          className="z-[200] px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-white
            bg-[#0e1120] border border-white/[0.08] shadow-xl
            data-[state=delayed-open]:animate-fade-in
            data-[state=closed]:opacity-0 transition-opacity"
        >
          {content}
          <RadixTooltip.Arrow className="fill-[#0e1120]" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
}
