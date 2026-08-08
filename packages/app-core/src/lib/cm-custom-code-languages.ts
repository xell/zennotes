/** CodeMirror decorations for TextMate-backed custom fenced languages. */
import { syntaxTree } from "@codemirror/language";
import { StateEffect, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { isReservedCodeFenceTag } from "@shared/custom-code-languages";
import {
  customCodeLanguageRegistry,
  EDITOR_TOKEN_CLASS,
} from "./custom-code-languages";

const refreshCustomLanguages = StateEffect.define<void>();

function buildDecorations(view: EditorView): DecorationSet {
  // The extension is installed unconditionally, but almost no vault has a
  // custom grammar. Bail before walking the syntax tree so the common case
  // costs nothing on every edit and every viewport change.
  if (customCodeLanguageRegistry.isEmpty) return Decoration.none;
  const ranges: Array<{ from: number; to: number; className: string }> = [];
  syntaxTree(view.state).iterate({
    enter(node) {
      if (node.name !== "FencedCode") return;
      const info = node.node.getChild("CodeInfo");
      const body = node.node.getChild("CodeText");
      if (!info || !body) return false;
      const tag = view.state.doc.sliceString(info.from, info.to);
      // Built-in grammars always win, even if a pack was added by hand with a
      // conflicting alias outside the Settings validation path. The claim is
      // settled by exact tag, not by `resolveCodeLanguage`: its fallback to
      // CodeMirror's fuzzy `matchLanguageName` also claims every tag that
      // merely *contains* a built-in name, which left importable tags like
      // `jsonnet` and `crystalline` installed but never decorated.
      if (isReservedCodeFenceTag(tag)) return false;
      if (!customCodeLanguageRegistry.resolve(tag)) return false;
      const source = view.state.doc.sliceString(body.from, body.to);
      for (const token of customCodeLanguageRegistry.tokenize(tag, source)) {
        if (token.to <= token.from) continue;
        ranges.push({
          from: body.from + token.from,
          to: body.from + token.to,
          className: EDITOR_TOKEN_CLASS[token.kind],
        });
      }
      return false;
    },
  });
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(
    ranges.map((range) =>
      Decoration.mark({ class: range.className }).range(range.from, range.to),
    ),
    true,
  );
}

export const customCodeFenceHighlightExtension: Extension =
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private unsubscribe: () => void;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
        this.unsubscribe = customCodeLanguageRegistry.subscribe(() => {
          view.dispatch({ effects: refreshCustomLanguages.of(undefined) });
        });
      }

      update(update: ViewUpdate): void {
        // `buildDecorations` walks the whole document, so the set does not go
        // stale when the viewport moves: rebuilding on `viewportChanged` only
        // re-tokenized every fence on every scroll frame. It does go stale
        // when the incremental parse catches up, which is how a fence far down
        // a long note gets decorated at all.
        if (
          update.docChanged ||
          syntaxTree(update.state) !== syntaxTree(update.startState) ||
          update.transactions.some((transaction) =>
            transaction.effects.some((effect) =>
              effect.is(refreshCustomLanguages),
            ),
          )
        ) {
          this.decorations = buildDecorations(update.view);
        }
      }

      destroy(): void {
        this.unsubscribe();
      }
    },
    { decorations: (value) => value.decorations },
  );
