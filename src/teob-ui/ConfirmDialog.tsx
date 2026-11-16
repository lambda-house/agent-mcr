import type { ReactNode } from 'react'
import { Button } from './Button'
import { Dialog } from './Dialog'

export interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  description: ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  danger = false,
  busy = false,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onClose()
      }}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={danger ? 'destructive' : 'primary'} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description}
    </Dialog>
  )
}
