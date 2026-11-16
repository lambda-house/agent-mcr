import { useState, type ReactNode } from 'react'
import { Button } from './Button'
import { CodeBlock } from './CodeBlock'
import { DescList, type DescListItem } from './DescList'
import { Dialog } from './Dialog'
import { SegmentedControl } from './Tabs'
import { toast } from './Toast'

export interface PayloadSection {
  key: string
  label: string
  /** Structured key-value items or raw string/JSON payload. */
  items?: DescListItem[]
  code?: string
  language?: string
  content?: ReactNode
}

export interface RawPayloadModalProps {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  /** Single JSON/raw payload when only one tab is needed. */
  payload?: unknown
  /** Multiple deep-inspection tabs (e.g., Raw JSON, Prompt, CLI Command, Advanced Settings). */
  sections?: PayloadSection[]
}

const css = `
@layer teob-ui {
.ui-payload-modal .ui-dialog {
  width: min(760px, 100%);
}
.ui-payload-modal__sub {
  margin-bottom: var(--sp-3);
  font-size: var(--fs-12);
  color: var(--text-muted);
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}
.ui-payload-modal__tabs {
  margin-bottom: var(--sp-3);
}
}
`

function formatPayload(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * Layer 3 Progressive Disclosure Escape Hatch (`RawPayloadModal`).
 * Keeps the primary screen calm and focused on the main macro-metaphor while giving
 * engineers one-click access to complete raw JSON, prompts, CLI commands, and deep settings.
 */
export function RawPayloadModal({
  open,
  onClose,
  title,
  subtitle,
  payload,
  sections,
}: RawPayloadModalProps) {
  const resolvedSections: PayloadSection[] =
    sections && sections.length > 0
      ? sections
      : [
          {
            key: 'json',
            label: 'Raw JSON',
            code: formatPayload(payload ?? {}),
            language: 'json',
          },
        ]

  const [activeTab, setActiveTab] = useState<string>(resolvedSections[0]?.key ?? 'json')
  const current = resolvedSections.find((s) => s.key === activeTab) ?? resolvedSections[0]

  return (
    <>
      <style href="ui-raw-payload-modal" precedence="default">{css}</style>
      <div className="ui-payload-modal">
        <Dialog
          open={open}
          onClose={onClose}
          title={title}
          footer={
            <>
              {current?.code && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(current.code ?? '')
                    toast({ title: 'Copied to clipboard' })
                  }}
                >
                  Copy {current.label}
                </Button>
              )}
              <Button variant="primary" size="sm" onClick={onClose}>
                Done
              </Button>
            </>
          }
        >
          {subtitle && <div className="ui-payload-modal__sub">{subtitle}</div>}
          {resolvedSections.length > 1 && (
            <div className="ui-payload-modal__tabs">
              <SegmentedControl
                aria-label="Inspection view"
                tabs={resolvedSections.map((s) => [s.key, s.label])}
                value={current.key}
                onChange={setActiveTab}
              />
            </div>
          )}
          {current?.items && <DescList items={current.items} />}
          {current?.code !== undefined && (
            <CodeBlock
              code={current.code}
              language={current.language ?? 'json'}
              label={current.label}
              maxHeight={420}
            />
          )}
          {current?.content}
        </Dialog>
      </div>
    </>
  )
}
