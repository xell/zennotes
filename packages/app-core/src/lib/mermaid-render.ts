/**
 * Mermaid, shared by every surface that draws one: the Preview pipeline and the
 * editor's live preview.
 *
 * It lives here rather than beside either caller because a second copy of the
 * theme is a second answer to "what colour is a node", and this codebase has
 * already paid for duplicated rendering rules more than once. The lazy import
 * is a singleton for the same reason the chunk is lazy at all: mermaid is the
 * heaviest thing the renderer can pull, and it must stay off the boot path, so
 * nothing here runs until a note actually contains a mermaid fence.
 */

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
export function loadMermaid(): Promise<typeof import("mermaid").default> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default);
  }
  return mermaidPromise;
}

/** Read a `--z-*` CSS variable (stored as `"R G B"` triplet) as a hex
 *  color string. Mermaid's themeVariables expect real color values, not
 *  raw triplets. Falls back to a neutral grey if the var is missing. */
function readThemeColor(name: string, fallback = "#888888"): string {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  if (!raw) return fallback;
  const parts = raw.split(/[\s,]+/).map((n) => Number(n));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return fallback;
  const hex = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${hex(parts[0])}${hex(parts[1])}${hex(parts[2])}`;
}

/** The stack `.prose-zen` falls back to when no text font is configured.
 *  Kept byte-identical to the `--z-text-font` fallback in index.css: mermaid
 *  measures against whatever this says, so a drift here reintroduces the
 *  clipped labels this helper exists to prevent. */
const PROSE_FONT_FALLBACK =
  '"SF Mono", "SFMono-Regular", ui-monospace, "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** Read a `--z-*` CSS font variable as a concrete font-family string.
 *  Mermaid measures text in a temporary element appended to the document
 *  body, so `fontFamily: "inherit"` can resolve to a different font than the
 *  one used inside `.prose-zen`. Passing the resolved stack avoids clipped
 *  labels caused by mismatched text metrics. */
function readThemeFont(name: string, fallback = PROSE_FONT_FALLBACK): string {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return raw || fallback;
}

export interface MermaidThemeConfig {
  theme: "base";
  themeVariables: Record<string, string>;
  darkMode: boolean;
}

/** Build a complete Mermaid themeVariables map from the current `--z-*`
 *  CSS custom properties on `<html>`. We use mermaid's `base` theme and
 *  drive every color from the app theme so the diagram naturally matches
 *  whichever of the 16+ app themes is active. */
export function buildMermaidTheme(mode: "light" | "dark"): MermaidThemeConfig {
  const bg = readThemeColor("--z-bg");
  const bg1 = readThemeColor("--z-bg-1");
  const bg2 = readThemeColor("--z-bg-2");
  const bg3 = readThemeColor("--z-bg-3");
  const bgSofter = readThemeColor("--z-bg-softer", bg1);
  const fg = readThemeColor("--z-fg");
  const fg1 = readThemeColor("--z-fg-1", fg);
  const grey = readThemeColor("--z-grey-1");
  const accent = readThemeColor("--z-accent", "#c35e0a");
  const red = readThemeColor("--z-red", "#c14a4a");
  const green = readThemeColor("--z-green", "#6c782e");
  const yellow = readThemeColor("--z-yellow", "#b47109");
  const blue = readThemeColor("--z-blue", "#45707a");
  const purple = readThemeColor("--z-purple", "#945e80");
  const aqua = readThemeColor("--z-aqua", "#4c7a5d");
  const fontFamily = readThemeFont("--z-text-font");

  return {
    theme: "base",
    darkMode: mode === "dark",
    themeVariables: {
      // Typography
      fontFamily,
      fontSize: "14px",

      // Core palette — mermaid derives most diagrams from these.
      background: bg,
      primaryColor: bg2,
      primaryTextColor: fg1,
      primaryBorderColor: bg3,
      secondaryColor: bg1,
      secondaryTextColor: fg,
      secondaryBorderColor: bg3,
      tertiaryColor: bgSofter,
      tertiaryTextColor: fg,
      tertiaryBorderColor: bg3,

      // Flow nodes + edges
      mainBkg: bg2,
      nodeBorder: bg3,
      nodeTextColor: fg1,
      lineColor: grey,
      arrowheadColor: grey,
      edgeLabelBackground: bg,

      // Cluster / subgraph
      clusterBkg: bgSofter,
      clusterBorder: bg3,
      titleColor: fg1,

      // Sequence diagrams
      actorBkg: bg2,
      actorBorder: bg3,
      actorTextColor: fg1,
      actorLineColor: grey,
      signalColor: fg,
      signalTextColor: fg,
      labelBoxBkgColor: bg2,
      labelBoxBorderColor: bg3,
      labelTextColor: fg1,
      loopTextColor: fg,
      noteBkgColor: bgSofter,
      noteBorderColor: bg3,
      noteTextColor: fg1,
      activationBkgColor: bg3,
      activationBorderColor: grey,
      sequenceNumberColor: bg,

      // State / class diagrams
      labelColor: fg1,
      altBackground: bgSofter,
      transitionColor: grey,
      transitionLabelColor: fg,
      stateLabelColor: fg1,
      stateBkg: bg2,
      compositeBackground: bgSofter,
      compositeBorder: bg3,
      compositeTitleBackground: bg1,
      specialStateColor: accent,
      innerEndBackground: fg1,

      // ER diagrams
      attributeBackgroundColorOdd: bg,
      attributeBackgroundColorEven: bgSofter,

      // Gantt
      taskBkgColor: accent,
      taskTextColor: bg,
      taskTextOutsideColor: fg1,
      taskTextLightColor: bg,
      taskTextDarkColor: fg1,
      taskTextClickableColor: accent,
      activeTaskBkgColor: accent,
      activeTaskBorderColor: accent,
      doneTaskBkgColor: bg3,
      doneTaskBorderColor: grey,
      gridColor: bg3,
      sectionBkgColor: bg1,
      sectionBkgColor2: bgSofter,
      altSectionBkgColor: bgSofter,

      // XY chart
      xyChart: JSON.stringify({
        backgroundColor: bg,
        titleColor: fg1,
        xAxisLabelColor: fg,
        xAxisTitleColor: fg1,
        xAxisTickColor: grey,
        xAxisLineColor: grey,
        yAxisLabelColor: fg,
        yAxisTitleColor: fg1,
        yAxisTickColor: grey,
        yAxisLineColor: grey,
        plotColorPalette: [accent, blue, green, purple, yellow, red, aqua].join(
          ", ",
        ),
      }),

      // Git graph
      git0: accent,
      git1: blue,
      git2: green,
      git3: purple,
      git4: yellow,
      git5: red,
      git6: aqua,
      git7: fg,
      gitBranchLabel0: bg,
      gitBranchLabel1: bg,
      gitBranchLabel2: bg,
      gitBranchLabel3: bg,
      gitBranchLabel4: fg1,
      gitBranchLabel5: bg,
      gitBranchLabel6: bg,
      gitBranchLabel7: bg,

      // Pie
      pie1: accent,
      pie2: blue,
      pie3: green,
      pie4: purple,
      pie5: yellow,
      pie6: red,
      pie7: aqua,
      pie8: fg1,
      pie9: grey,
      pie10: bg3,
      pieTitleTextColor: fg1,
      pieSectionTextColor: bg,
      pieLegendTextColor: fg1,
      pieStrokeColor: bg,
      pieOuterStrokeColor: grey,

      // Signals / errors
      errorBkgColor: red,
      errorTextColor: bg,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Rendered SVG, cached                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One entry per (source, full theme identity). Keyed by the diagram text
 * itself, so an editor that re-renders on every keystroke pays for a diagram
 * once and a cursor moving in and out of a block costs nothing at all.
 */
const svgCache = new Map<string, MermaidRenderResult>();
const inFlight = new Map<string, Promise<MermaidRenderResult>>();

/** Bounded so a long editing session cannot grow it without limit. Diagrams are
 *  big strings; the number is small on purpose. */
const SVG_CACHE_LIMIT = 60;

export type MermaidRenderResult = { ok: true; svg: string } | { ok: false; error: string };

function cacheKey(source: string, mode: "light" | "dark", themeKey: string): string {
  return `${mode}\u0000${themeKey}\u0000${source}`;
}

/** A finished render, or null when this diagram has not been drawn yet. Lets a
 *  widget paint synchronously on re-mount instead of flashing empty. */
export function peekMermaidSvg(
  source: string,
  mode: "light" | "dark",
  themeKey: string = mode,
): MermaidRenderResult | null {
  return svgCache.get(cacheKey(source, mode, themeKey)) ?? null;
}

/** Render to an SVG string, reusing an in-flight render of the same diagram.
 *  Never throws: a broken diagram is a result the caller can show. */
export function renderMermaidSvg(
  source: string,
  mode: "light" | "dark",
  themeKey: string = mode,
  idPrefix = "zen-mermaid-live",
): Promise<MermaidRenderResult> {
  const key = cacheKey(source, mode, themeKey);
  const cached = svgCache.get(key);
  if (cached) return Promise.resolve(cached);
  const running = inFlight.get(key);
  if (running) return running;

  const task = (async (): Promise<MermaidRenderResult> => {
    try {
      const mermaid = await loadMermaid();
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        ...buildMermaidTheme(mode),
      });
      // The id must be unique per render: mermaid puts it in the DOM and a
      // repeat collides with the diagram already on screen.
      const id = `${idPrefix}-${renderSeq++}`;
      const { svg } = await mermaid.render(id, source);
      return { ok: true, svg };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })();

  inFlight.set(key, task);
  return task.then((result) => {
    inFlight.delete(key);
    if (svgCache.size >= SVG_CACHE_LIMIT) {
      const oldest = svgCache.keys().next().value;
      if (oldest !== undefined) svgCache.delete(oldest);
    }
    svgCache.set(key, result);
    return result;
  });
}

let renderSeq = 0;
