import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  RESERVED_CODE_FENCE_TAGS,
  parseTextMateGrammar,
  validateCustomCodeLanguageManifest,
  type CustomCodeLanguage,
} from "@shared/custom-code-languages";
import { refreshCustomCodeLanguages, useStore } from "../store";
import {
  customCodeLanguageRegistry,
  PREVIEW_TOKEN_CLASS,
  tokenizeCustomGrammarPreview,
  type CodeHighlightToken,
} from "../lib/custom-code-languages";
import { confirmApp } from "../lib/confirm-requests";
import { TrashIcon, ExternalIcon } from "./icons";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

const DEFAULT_SAMPLE = `module hello

// Replace this with a small sample in your language.
let answer = 42
`;

interface Draft {
  editingId?: string;
  fileName: string;
  grammar: string;
  name: string;
  id: string;
  aliases: string;
  scopeName: string;
  sample: string;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.tmlanguage\.json$/i, "")
    .replace(/[^a-z0-9_+#-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// A language the renderer gave up on mid-session is not reflected on disk, so
// this state comes from the registry rather than the store.
const subscribeToRegistry = (onChange: () => void): (() => void) =>
  customCodeLanguageRegistry.subscribe(onChange);
const registryRevision = (): number => customCodeLanguageRegistry.revision;

export function CustomCodeLanguagesSettings(): JSX.Element {
  const languages = useStore((state) => state.customCodeLanguages);
  const revision = useSyncExternalStore(subscribeToRegistry, registryRevision);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const quarantined = useMemo(() => {
    const reasons = new Map<string, string>();
    for (const language of languages) {
      const reason = customCodeLanguageRegistry.quarantineReason(language.id);
      if (reason) reasons.set(language.id, reason);
    }
    return reasons;
  }, [languages, revision]);

  const chooseFile = (): void => inputRef.current?.click();

  const readFile = async (file: File): Promise<void> => {
    try {
      const grammar = await file.text();
      const parsed = parseTextMateGrammar(grammar);
      const inferredName =
        parsed.name ?? file.name.replace(/\.tmlanguage\.json$/i, "");
      const inferredId =
        slugify(inferredName || file.name) || "custom-language";
      setDraft({
        fileName: file.name,
        grammar,
        name: inferredName,
        id: inferredId,
        aliases: inferredId,
        scopeName: parsed.scopeName,
        sample: DEFAULT_SAMPLE,
      });
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Could not read this grammar file.",
      );
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const editLanguage = (language: CustomCodeLanguage): void => {
    setDraft({
      editingId: language.id,
      fileName: `${language.id}.tmLanguage.json`,
      grammar: language.grammar,
      name: language.name,
      id: language.id,
      aliases: language.aliases.join(", "),
      scopeName: language.scopeName,
      sample: DEFAULT_SAMPLE,
    });
  };

  const toggleLanguage = async (
    language: CustomCodeLanguage,
    enabled: boolean,
  ): Promise<void> => {
    setBusyId(language.id);
    try {
      await window.zen.updateCustomCodeLanguage({ id: language.id, enabled });
      refreshCustomCodeLanguages();
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Could not update this language.",
      );
    } finally {
      setBusyId(null);
    }
  };

  const removeLanguage = async (
    language: CustomCodeLanguage,
  ): Promise<void> => {
    const ok = await confirmApp({
      title: `Remove “${language.name}”?`,
      description:
        "This deletes its grammar and manifest from your custom languages folder.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setBusyId(language.id);
    try {
      await window.zen.deleteCustomCodeLanguage(language.id);
      refreshCustomCodeLanguages();
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Could not remove this language.",
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <input
        ref={inputRef}
        type="file"
        accept=".json,.tmLanguage.json,application/json"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void readFile(file);
        }}
      />
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-ink-900">
            Custom code languages
          </h3>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-500">
            Import a self-contained TextMate JSON grammar to highlight its
            fenced code blocks in Edit, Split, and Preview. Custom tags cannot
            replace built-in languages or diagrams.
          </p>
        </div>
        <Button onClick={chooseFile}>Add language</Button>
      </div>

      {languages.length === 0 ? (
        <button
          type="button"
          onClick={chooseFile}
          className="w-full rounded-xl border border-dashed border-paper-300/70 px-4 py-8 text-center text-xs text-ink-500 transition-colors hover:bg-paper-100/70"
        >
          Drop-in support starts with a{" "}
          <span className="font-mono text-ink-700">.tmLanguage.json</span> file.
          Select one to configure its fence tag and preview it.
        </button>
      ) : (
        <div className="space-y-2">
          {languages.map((language) => (
            <div
              key={language.id}
              className="group flex items-center gap-3 rounded-xl border border-paper-300/70 bg-paper-100/70 px-3 py-2.5"
            >
              <input
                type="checkbox"
                checked={language.enabled && !language.error}
                disabled={!!language.error || busyId === language.id}
                onChange={(event) =>
                  void toggleLanguage(language, event.target.checked)
                }
                aria-label={`Enable ${language.name}`}
                className="h-4 w-4 accent-accent"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-ink-800">
                    {language.name}
                  </span>
                  {language.error && (
                    <span className="text-xs text-danger">error</span>
                  )}
                  {!language.error && quarantined.has(language.id) && (
                    <span className="text-xs text-warning">paused</span>
                  )}
                </div>
                <div className="mt-0.5 truncate font-mono text-2xs text-ink-400">
                  {language.error ??
                    quarantined.get(language.id) ??
                    language.aliases.join(" · ")}
                </div>
              </div>
              {!language.error && (
                <button
                  type="button"
                  onClick={() => editLanguage(language)}
                  className="text-xs text-ink-500 hover:text-ink-800"
                >
                  Edit
                </button>
              )}
              <button
                type="button"
                title="Reveal grammar"
                aria-label={`Reveal ${language.name} grammar`}
                onClick={() =>
                  void window.zen.revealCustomCodeLanguagesDir(language.id)
                }
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-400 hover:bg-paper-300/70 hover:text-ink-800"
              >
                <ExternalIcon width={13} height={13} />
              </button>
              <button
                type="button"
                title="Remove language"
                aria-label={`Remove ${language.name}`}
                onClick={() => void removeLanguage(language)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-400 hover:bg-paper-300/70 hover:text-danger"
              >
                <TrashIcon width={13} height={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => void window.zen.revealCustomCodeLanguagesDir()}
        className="text-xs text-ink-500 hover:text-ink-800"
      >
        Open languages folder
      </button>

      {draft && (
        <LanguageImportDialog
          draft={draft}
          languages={languages}
          onChange={setDraft}
          onClose={() => setDraft(null)}
        />
      )}
    </div>
  );
}

function LanguageImportDialog({
  draft,
  languages,
  onChange,
  onClose,
}: {
  draft: Draft;
  languages: CustomCodeLanguage[];
  onChange: (draft: Draft) => void;
  onClose: () => void;
}): JSX.Element {
  const [tokens, setTokens] = useState<CodeHighlightToken[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(true);
  const [saving, setSaving] = useState(false);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const aliases = useMemo(
    () =>
      draft.aliases
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    [draft.aliases],
  );
  let validationError: string | null = null;
  try {
    validateCustomCodeLanguageManifest(
      {
        id: draft.id,
        name: draft.name,
        aliases,
        scopeName: draft.scopeName,
        enabled: true,
      },
      {
        reservedAliases: RESERVED_CODE_FENCE_TAGS,
        existing: languages,
        replacingId: draft.editingId,
      },
    );
  } catch (error) {
    validationError =
      error instanceof Error ? error.message : "Invalid language metadata.";
  }

  useEffect(() => {
    let cancelled = false;
    setTokens([]);
    setPreviewError(null);
    setPreviewing(true);
    const timer = window.setTimeout(() => {
      void tokenizeCustomGrammarPreview(
        {
          schemaVersion: 1,
          id: draft.id,
          name: draft.name,
          aliases: aliases.length ? aliases : [draft.id],
          scopeName: draft.scopeName,
          enabled: true,
          grammar: draft.grammar,
        },
        draft.sample,
      ).then(
        (next) => {
          if (!cancelled) {
            setTokens(next);
            setPreviewing(false);
          }
        },
        (error) => {
          if (!cancelled) {
            setPreviewError(
              error instanceof Error ? error.message : "Preview failed.",
            );
            setPreviewing(false);
          }
        },
      );
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    aliases.join("\0"),
    draft.grammar,
    draft.id,
    draft.name,
    draft.sample,
    draft.scopeName,
  ]);

  const save = async (): Promise<void> => {
    if (validationError) return;
    setSaving(true);
    try {
      await window.zen.installCustomCodeLanguage({
        fileName: draft.fileName,
        grammar: draft.grammar,
        id: draft.id,
        name: draft.name,
        aliases,
        enabled: true,
        replace: !!draft.editingId,
      });
      refreshCustomCodeLanguages();
      onClose();
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Could not install this language.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      size="lg"
      layer="nested"
      align="center"
      onClose={onClose}
      labelledBy="custom-language-dialog-title"
      className="flex max-h-[88vh] flex-col"
    >
      <Modal.Header
        titleId="custom-language-dialog-title"
        title={draft.editingId ? "Edit language" : "Add language"}
        description={`${draft.fileName} · ${draft.scopeName}`}
      />
      <Modal.Body className="flex-1 overflow-auto">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-xs text-ink-600">
            Display name
            <input
              value={draft.name}
              onChange={(event) =>
                onChange({ ...draft, name: event.target.value })
              }
              className="mt-1 w-full rounded-lg border border-paper-300 bg-paper-100 px-3 py-2 text-sm text-ink-900 outline-none focus:border-accent/60"
            />
          </label>
          <label className="text-xs text-ink-600">
            Primary fence tag
            <input
              value={draft.id}
              disabled={!!draft.editingId}
              onChange={(event) =>
                onChange({ ...draft, id: slugify(event.target.value) })
              }
              className="mt-1 w-full rounded-lg border border-paper-300 bg-paper-100 px-3 py-2 font-mono text-sm text-ink-900 outline-none disabled:opacity-60 focus:border-accent/60"
            />
          </label>
          <label className="text-xs text-ink-600 sm:col-span-2">
            Fence tags and aliases, comma-separated
            <input
              value={draft.aliases}
              onChange={(event) =>
                onChange({ ...draft, aliases: event.target.value })
              }
              className="mt-1 w-full rounded-lg border border-paper-300 bg-paper-100 px-3 py-2 font-mono text-sm text-ink-900 outline-none focus:border-accent/60"
            />
          </label>
        </div>

        <input
          ref={replaceInputRef}
          type="file"
          accept=".json,.tmLanguage.json,application/json"
          className="hidden"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (!file) return;
            void file.text().then((grammar) => {
              try {
                const parsed = parseTextMateGrammar(grammar);
                onChange({
                  ...draft,
                  fileName: file.name,
                  grammar,
                  scopeName: parsed.scopeName,
                });
              } catch (error) {
                window.alert(
                  error instanceof Error
                    ? error.message
                    : "Invalid grammar file.",
                );
              } finally {
                if (replaceInputRef.current) replaceInputRef.current.value = "";
              }
            });
          }}
        />
        <button
          type="button"
          onClick={() => replaceInputRef.current?.click()}
          className="mt-3 text-xs text-ink-500 hover:text-ink-800"
        >
          Choose a different grammar file
        </button>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <label className="text-xs text-ink-600">
            Sample code
            <textarea
              value={draft.sample}
              onChange={(event) =>
                onChange({ ...draft, sample: event.target.value })
              }
              className="mt-1 h-52 w-full resize-none rounded-xl border border-paper-300 bg-paper-100 p-3 font-mono text-xs leading-5 text-ink-900 outline-none focus:border-accent/60"
            />
          </label>
          <div className="text-xs text-ink-600">
            Preview
            <pre className="prose-zen mt-1 h-52 overflow-auto rounded-xl border border-paper-300 bg-paper-100 p-3 text-left font-mono text-xs leading-5">
              <code className="hljs">
                {renderPreview(draft.sample, tokens)}
              </code>
            </pre>
          </div>
        </div>

        {(validationError || previewError) && (
          <p className="mt-4 rounded-lg border border-danger/35 bg-danger/5 px-3 py-2 text-xs text-danger">
            {validationError ?? previewError}
          </p>
        )}
      </Modal.Body>

      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!!validationError || !!previewError || previewing || saving}
          onClick={() => void save()}
        >
          {previewing
            ? "Checking grammar…"
            : saving
              ? "Saving…"
              : draft.editingId
                ? "Save changes"
                : "Install language"}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

function renderPreview(
  source: string,
  tokens: CodeHighlightToken[],
): JSX.Element[] {
  const nodes: JSX.Element[] = [];
  let offset = 0;
  tokens.forEach((token, index) => {
    if (token.from > offset)
      nodes.push(
        <Fragment key={`text-${index}`}>
          {source.slice(offset, token.from)}
        </Fragment>,
      );
    nodes.push(
      <span key={`token-${index}`} className={PREVIEW_TOKEN_CLASS[token.kind]}>
        {source.slice(token.from, token.to)}
      </span>,
    );
    offset = token.to;
  });
  if (offset < source.length)
    nodes.push(<Fragment key="tail">{source.slice(offset)}</Fragment>);
  return nodes;
}
