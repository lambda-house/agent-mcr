// ── 0. Utilities ───────────────────────────────────────────────────────────
export { cx } from './cx'
export { errorText } from './errorText'
export {
  AnimatedItem,
  AnimatedList,
  AnimatePresence,
  m,
  motionEase,
  motionEnter,
  motionExit,
  MotionProvider,
  useReducedMotion,
} from './motion'

// ── 1. Atoms (Smallest indivisible building blocks) ────────────────────────
export { Avatar, type AvatarProps } from './Avatar'
export { Badge, type BadgeProps, type BadgeTone } from './Badge'
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button'
export { Checkbox, type CheckboxProps } from './Checkbox'
export { Icon, type IconName, type IconProps } from './Icon'
export { InlineError } from './InlineError'
export { Input, type InputProps } from './Input'
export { Kbd, type KbdProps } from './Kbd'
export { Progress, type ProgressProps, type ProgressTone } from './Progress'
export { ScrollArea, type ScrollAreaProps } from './ScrollArea'
export { Select, type SelectProps } from './Select'
export { Skeleton, type SkeletonProps } from './Skeleton'
export { StatusDot, type StatusDotProps, type StatusDotTone } from './StatusDot'
export { Textarea, type TextareaProps } from './Textarea'
export { Tooltip, type TooltipProps, type TooltipSide } from './Tooltip'

// ── 2. Molecules (Focused groups of atoms functioning as a single unit) ────
export { Card, CardContent, CardFooter, CardHeader, ZonedCard, type CardHeaderProps, type CardProps } from './Card'
export { CodeBlock, type CodeBlockProps } from './CodeBlock'
export { Combobox, type ComboboxOption, type ComboboxProps } from './Combobox'
export { DescList, type DescListItem, type DescListProps } from './DescList'
export { DiffView, type DiffLine, type DiffLineKind, type DiffViewProps } from './DiffView'
export { Disclosure, type DisclosureProps } from './Disclosure'
export { FilterMenu, type FilterGroup, type FilterMenuProps, type FilterOption } from './FilterMenu'
export { FormActions, type FormActionsProps } from './FormActions'
export { Menu, type MenuItem, type MenuProps } from './Menu'
export { Notice, type NoticeProps, type NoticeTone } from './Notice'
export { Popover, type PopoverProps } from './Popover'
export { SettingRow, type SettingRowProps } from './SettingRow'
export { StatTile, type StatTileProps, type StatTone } from './StatTile'
export {
  EmptyLine,
  EmptyState,
  ErrorState,
  LoadingRows,
  NoAccessState,
  type EmptyStateProps,
  type ErrorStateProps,
  type LoadingRowsProps,
  type NoAccessStateProps,
} from './State'
export { SegmentedControl, Tabs, type SegmentedControlProps, type TabsProps } from './Tabs'
export { ToastProvider, toast, useToast, type ToastAction, type ToastOptions, type ToastTone } from './Toast'

// ── 3. Organisms (Self-contained domain sections & composite blocks) ───────
export { ApprovalCard, type ApprovalAction, type ApprovalCardProps, type ApprovalRisk } from './ApprovalCard'
export { Checklist, type ChecklistItem, type ChecklistProps } from './Checklist'
export { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog'
export { DataTable, type Column, type DataTableProps, type SortDirection } from './DataTable'
export { DetailPanel, type DetailPanelProps } from './DetailPanel'
export { Dialog, type DialogProps } from './Dialog'
export { PageHeader, type Crumb, type PageHeaderProps } from './PageHeader'
export {
  RawPayloadModal,
  type PayloadSection,
  type RawPayloadModalProps,
} from './RawPayloadModal'
export { Section, type SectionProps } from './Section'
export { Stepper, type StepperProps, type StepperStep } from './Stepper'

// ── 4. Templates & Harnesses (Page-level structures & multi-variant switcher)
export { InsetShell, type InsetShellProps } from './InsetShell'
export { Page, type PageProps } from './Page'
export {
  PrototypeSwitcher,
  type PrototypeDataset,
  type PrototypeOption,
  type PrototypeSwitcherProps,
} from './PrototypeSwitcher'

