import { useRef, useState } from "react";
import type { TextReplacements } from "../lib/cm-text-replacements";
import { TrashIcon } from "./icons";
import { Button, IconButton } from "./ui/Button";

interface ReplacementRow {
  id: number;
  trigger: string;
  replacement: string;
}

function rowsToReplacements(rows: ReplacementRow[]): TextReplacements {
  const next: TextReplacements = {};
  for (const row of rows) {
    if (row.trigger.length === 0) continue;
    next[row.trigger] = row.replacement;
  }
  return next;
}

export function TextReplacementsSettings({
  replacements,
  onChange,
}: {
  replacements: TextReplacements;
  onChange: (next: TextReplacements) => void;
}): JSX.Element {
  const nextId = useRef(1);
  const [rows, setRows] = useState<ReplacementRow[]>(() =>
    Object.entries(replacements).map(([trigger, replacement]) => ({
      id: nextId.current++,
      trigger,
      replacement,
    })),
  );

  const updateRows = (next: ReplacementRow[]): void => {
    setRows(next);
    onChange(rowsToReplacements(next));
  };

  const updateRow = (
    id: number,
    field: "trigger" | "replacement",
    value: string,
  ): void => {
    updateRows(
      rows.map((row) => (row.id === id ? { ...row, [field]: value } : row)),
    );
  };

  return (
    <div className="space-y-3 px-5 py-4">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2 text-xs font-medium text-ink-500">
        <span>Type</span>
        <span>Replace with</span>
        <span className="sr-only">Actions</span>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-paper-300 px-3 py-4 text-center text-xs text-ink-500">
          No replacements yet. Add one to get started.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div
              key={row.id}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-2"
            >
              <input
                type="text"
                value={row.trigger}
                maxLength={64}
                aria-label="Text to replace"
                placeholder="->"
                onChange={(event) =>
                  updateRow(row.id, "trigger", event.target.value)
                }
                className="min-w-0 rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 font-mono text-sm text-ink-900 outline-none focus:border-accent"
              />
              <input
                type="text"
                value={row.replacement}
                maxLength={4000}
                aria-label="Replacement text"
                placeholder="→"
                onChange={(event) =>
                  updateRow(row.id, "replacement", event.target.value)
                }
                className="min-w-0 rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none focus:border-accent"
              />
              <IconButton
                size="sm"
                aria-label={`Delete replacement ${row.trigger || "rule"}`}
                title="Delete replacement"
                onClick={() =>
                  updateRows(
                    rows.filter((candidate) => candidate.id !== row.id),
                  )
                }
              >
                <TrashIcon width={13} height={13} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-3 pt-1">
        <p className="text-xs leading-5 text-ink-500">
          The longest matching trigger wins. Replacements run only while typing.
        </p>
        <Button
          variant="secondary"
          size="sm"
          disabled={rows.length >= 100}
          onClick={() =>
            setRows([
              ...rows,
              { id: nextId.current++, trigger: "", replacement: "" },
            ])
          }
        >
          Add replacement
        </Button>
      </div>
    </div>
  );
}
