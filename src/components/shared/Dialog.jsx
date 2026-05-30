import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'

export function Dialog({ open, onClose, children }) {
  return (
    <RadixDialog.Root open={open} onOpenChange={v => !v && onClose()}>
      <AnimatePresence>
        {open && (
          <RadixDialog.Portal forceMount>
            <RadixDialog.Overlay asChild>
              <motion.div
                className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              />
            </RadixDialog.Overlay>
            <RadixDialog.Content asChild>
              <motion.div
                className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
                initial={{ opacity: 0, scale: 0.96, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 8 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                <div className="pointer-events-auto w-full max-w-lg glass rounded-2xl shadow-2xl outline-none focus:outline-none">
                  {children}
                </div>
              </motion.div>
            </RadixDialog.Content>
          </RadixDialog.Portal>
        )}
      </AnimatePresence>
    </RadixDialog.Root>
  )
}

export function DialogHeader({ title, onClose }) {
  return (
    <div className="flex items-center justify-between p-5 border-b border-white/[0.06]">
      <RadixDialog.Title className="text-sm font-semibold text-white">{title}</RadixDialog.Title>
      <RadixDialog.Close asChild>
        <button
          onClick={onClose}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-500 hover:text-white hover:bg-white/[0.06] transition-colors"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </RadixDialog.Close>
    </div>
  )
}

export function DialogBody({ children, className = '' }) {
  return <div className={`p-5 ${className}`}>{children}</div>
}
