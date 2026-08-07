import { useEffect, useRef, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type {
  DatabaseDoc,
  DbField,
  DbView,
  FieldType,
  FilterConjunction,
  FilterOp,
  FilterRule
} from '@shared/databases'
import { updateView } from '../lib/database-cells'
import { useStore } from '../store'
import { IconButton } from './ui/Button'
import { CloseIcon, PlusIcon } from './icons'

/** User-facing label for each filter operator. */
const OP_LABELS: Record<FilterOp, string> = {
  is: 'is',
  isNot: 'is not',
  contains: 'contains',
  notContains: 'does not contain',
  isEmpty: 'is empty',
  isNotEmpty: 'is not empty',
  gt: 'greater than',
  lt: 'less than',
  before: 'before',
  after: 'after',
  checked: 'is checked',
  unchecked: 'is unchecked'
}

/** Which operators make sense for each field type. */
const OPS_FOR_TYPE: Record<FieldType, FilterOp[]> = {
  text: ['is', 'isNot', 'contains', 'notContains', 'isEmpty', 'isNotEmpty'],
  number: ['is', 'isNot', 'gt', 'lt', 'isEmpty', 'isNotEmpty'],
  date: ['is', 'before', 'after', 'isEmpty', 'isNotEmpty'],
  select: ['is', 'isNot', 'isEmpty', 'isNotEmpty'],
  multiSelect: ['is', 'isNot', 'isEmpty', 'isNotEmpty'],
  checkbox: ['checked', 'unchecked']
}

/** Operators that take no value input. */
const VALUELESS: ReadonlySet<FilterOp> = new Set(['isEmpty', 'isNotEmpty', 'checked', 'unchecked'])

const PANEL_WIDTH = 360
const CONTROL = 'rounded-md border border-paper-300 bg-paper-50 px-2 py-1 text-xs text-ink-900 outline-none focus:border-accent'

function opsFor(field: DbField | undefined): FilterOp[] {
  return field ? OPS_FOR_TYPE[field.type] : ['is']
}

/** A value input that adapts to the field type: a dropdown of options for
 *  select/multiSelect, a date/number/text input otherwise. */
function FilterValueInput({
  field,
  value,
  onChange
}: {
  field: DbField | undefined
  value: string
  onChange: (v: string) => void
}): JSX.Element {
  if (field && (field.type === 'select' || field.type === 'multiSelect')) {
    return (
      <select
        className={`${CONTROL} min-w-0 flex-1`}
        aria-label="Value"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Select…</option>
        {(field.options ?? []).map((o) => (
          <option key={o.id} value={o.value}>
            {o.label ?? o.value}
          </option>
        ))}
      </select>
    )
  }
  const type = field?.type === 'number' ? 'number' : field?.type === 'date' ? 'date' : 'text'
  return (
    <input
      type={type}
      value={value}
      aria-label="Value"
      placeholder="Value"
      onChange={(e) => onChange(e.target.value)}
      // Keep typing from leaking to grid / global shortcuts.
      onKeyDown={(e) => e.stopPropagation()}
      className={`${CONTROL} min-w-0 flex-1`}
    />
  )
}

/**
 * Popover for editing a view's filters (#394): a Match all/any (AND/OR) toggle
 * plus a list of `field op value` conditions. Persists through the same
 * `updateView` path the sort menu uses, so it round-trips into schema.json.
 */
export function DatabaseFilterMenu({
  csvPath,
  doc,
  view,
  anchor,
  onClose,
  ignoreRef
}: {
  csvPath: string
  doc: DatabaseDoc
  view: DbView
  anchor: DOMRect
  onClose: () => void
  /** The trigger element — clicks on it are ignored so it can toggle cleanly. */
  ignoreRef?: RefObject<HTMLElement>
}): JSX.Element {
  const updateDatabaseSchema = useStore((s) => s.updateDatabaseSchema)
  const panelRef = useRef<HTMLDivElement>(null)
  const filters = view.filters ?? []
  const conjunction: FilterConjunction = view.filterConjunction ?? 'and'
  // Filterable fields: everything the user can see as a column (skip the hidden id).
  const fields = doc.fields.filter((f) => !f.hidden)

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (ignoreRef?.current?.contains(target)) return // let the trigger toggle
      if (panelRef.current && !panelRef.current.contains(target)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose, ignoreRef])

  const persist = (nextFilters: FilterRule[], nextConjunction: FilterConjunction): void => {
    updateDatabaseSchema(
      csvPath,
      updateView(doc, view.id, { filters: nextFilters, filterConjunction: nextConjunction })
    )
  }
  const patchAt = (i: number, patch: Partial<FilterRule>): void =>
    persist(
      filters.map((f, idx) => (idx === i ? { ...f, ...patch } : f)),
      conjunction
    )
  const removeAt = (i: number): void => persist(filters.filter((_, idx) => idx !== i), conjunction)

  const addFilter = (): void => {
    const field = fields[0]
    if (!field) return
    const op = opsFor(field)[0]
    const rule: FilterRule = VALUELESS.has(op)
      ? { fieldId: field.id, op }
      : { fieldId: field.id, op, value: '' }
    persist([...filters, rule], conjunction)
  }
  const changeField = (i: number, fieldId: string): void => {
    const field = fields.find((f) => f.id === fieldId)
    const ops = opsFor(field)
    // Keep the current operator if the new type supports it, else fall back.
    const op = ops.includes(filters[i].op) ? filters[i].op : ops[0]
    patchAt(i, { fieldId, op, value: VALUELESS.has(op) ? undefined : (filters[i].value ?? '') })
  }
  const changeOp = (i: number, op: FilterOp): void =>
    patchAt(i, { op, value: VALUELESS.has(op) ? undefined : (filters[i].value ?? '') })

  const style: CSSProperties = {
    position: 'fixed',
    top: anchor.bottom + 6,
    left: Math.max(8, Math.min(anchor.left, window.innerWidth - PANEL_WIDTH - 8)),
    width: PANEL_WIDTH
  }

  return createPortal(
    <div
      ref={panelRef}
      style={style}
      role="dialog"
      aria-label="Filter rows"
      className="z-popover rounded-lg border border-paper-300 bg-paper-100 p-2 text-ink-900 shadow-float"
    >
      {filters.length === 0 ? (
        <p className="px-1 py-1.5 text-xs text-ink-500">No filters yet.</p>
      ) : (
        <div className="mb-1.5 flex items-center gap-1.5 px-1 text-xs text-ink-600">
          <span>Match</span>
          <select
            className={CONTROL}
            aria-label="Match all or any of the filters"
            value={conjunction}
            onChange={(e) => persist(filters, e.target.value as FilterConjunction)}
          >
            <option value="and">all</option>
            <option value="or">any</option>
          </select>
          <span>of the following</span>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {filters.map((f, i) => {
          const field = fields.find((x) => x.id === f.fieldId)
          const ops = opsFor(field)
          return (
            <div key={i} className="flex items-center gap-1.5">
              <select
                className={`${CONTROL} min-w-0 flex-1`}
                aria-label="Field"
                value={f.fieldId}
                onChange={(e) => changeField(i, e.target.value)}
              >
                {fields.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
              <select
                className={`${CONTROL} min-w-0 flex-1`}
                aria-label="Condition"
                value={f.op}
                onChange={(e) => changeOp(i, e.target.value as FilterOp)}
              >
                {ops.map((o) => (
                  <option key={o} value={o}>
                    {OP_LABELS[o]}
                  </option>
                ))}
              </select>
              {!VALUELESS.has(f.op) && (
                <FilterValueInput
                  field={field}
                  value={f.value ?? ''}
                  onChange={(v) => patchAt(i, { value: v })}
                />
              )}
              <IconButton size="sm" title="Remove filter" onClick={() => removeAt(i)}>
                <CloseIcon className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          )
        })}
      </div>

      <button
        type="button"
        onClick={addFilter}
        disabled={fields.length === 0}
        className="mt-2 flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-600 hover:bg-paper-200 hover:text-ink-900 disabled:opacity-50"
      >
        <PlusIcon className="h-3.5 w-3.5" /> Add filter
      </button>
    </div>,
    document.body
  )
}
