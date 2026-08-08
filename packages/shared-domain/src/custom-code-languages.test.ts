import { describe, expect, it } from "vitest";
import {
  RESERVED_CODE_FENCE_TAGS,
  isReservedCodeFenceTag,
  parseTextMateGrammar,
  validateCustomCodeLanguageManifest,
} from "./custom-code-languages";

const grammar = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    name: "Gleam",
    scopeName: "source.gleam",
    patterns: [{ match: "\\b(?:fn|let)\\b", name: "keyword.control.gleam" }],
    ...extra,
  });

describe("custom code language grammars", () => {
  it("accepts a self-contained TextMate JSON grammar", () => {
    expect(parseTextMateGrammar(grammar())).toMatchObject({
      name: "Gleam",
      scopeName: "source.gleam",
    });
  });

  it("rejects malformed and externally-dependent grammars", () => {
    expect(() => parseTextMateGrammar("{")).toThrow("valid JSON");
    expect(() =>
      parseTextMateGrammar(JSON.stringify({ scopeName: "source.gleam" })),
    ).toThrow("patterns array");
    expect(() =>
      parseTextMateGrammar(
        grammar({
          patterns: [
            { include: "source.javascript" },
            { include: "#comments" },
          ],
        }),
      ),
    ).toThrow("source.javascript");
  });

  it("normalizes aliases and blocks reserved or occupied fence tags", () => {
    expect(
      validateCustomCodeLanguageManifest(
        {
          id: "Gleam",
          name: " Gleam ",
          aliases: ["GLEAM", "gleam-lang"],
          scopeName: "source.gleam",
          enabled: true,
        },
        { reservedAliases: RESERVED_CODE_FENCE_TAGS },
      ),
    ).toMatchObject({
      id: "gleam",
      name: "Gleam",
      aliases: ["gleam", "gleam-lang"],
    });

    expect(() =>
      validateCustomCodeLanguageManifest(
        {
          id: "mermaid",
          name: "Not Mermaid",
          aliases: [],
          scopeName: "source.fake",
          enabled: true,
        },
        { reservedAliases: RESERVED_CODE_FENCE_TAGS },
      ),
    ).toThrow("reserved");

    expect(() =>
      validateCustomCodeLanguageManifest(
        {
          id: "csharp",
          name: "Custom C#",
          aliases: [],
          scopeName: "source.csharp-custom",
          enabled: true,
        },
        { reservedAliases: RESERVED_CODE_FENCE_TAGS },
      ),
    ).toThrow("reserved");

    expect(() =>
      validateCustomCodeLanguageManifest(
        {
          id: "gleam",
          name: "Gleam",
          aliases: ["moonbit"],
          scopeName: "source.gleam",
          enabled: true,
        },
        { existing: [{ id: "moonbit", aliases: ["mbt"] }] },
      ),
    ).toThrow("already used");
  });

  // Each of these used to import cleanly and then shadow a built-in in one
  // surface while rendering as plain text in the other, because the preview,
  // the editor, and the app each answered "is this tag taken?" differently.
  it("reserves every tag a bundled grammar or an app fence already claims", () => {
    const stillImportable = ["gleam", "moonbit", "jsonnet", "crystalline"];
    for (const tag of stillImportable) {
      expect(isReservedCodeFenceTag(tag)).toBe(false);
    }

    for (const tag of [
      "arduino",
      "ino",
      "text",
      "txt",
      "console",
      "shellsession",
      "patch",
      "embed",
      "bookmark",
      "mermaid",
    ]) {
      expect(isReservedCodeFenceTag(tag)).toBe(true);
      expect(isReservedCodeFenceTag(tag.toUpperCase())).toBe(true);
      expect(() =>
        validateCustomCodeLanguageManifest(
          {
            id: tag,
            name: `Custom ${tag}`,
            aliases: [],
            scopeName: `source.${tag.replace(/[^a-z0-9]/g, "")}-custom`,
            enabled: true,
          },
          { reservedAliases: RESERVED_CODE_FENCE_TAGS },
        ),
      ).toThrow("reserved");
    }
  });
});
