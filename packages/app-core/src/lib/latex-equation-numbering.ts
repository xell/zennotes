const EQUATION_ENVIRONMENT_RE = /\\begin\{equation\}([\s\S]*?)\\end\{equation\}/g
const EXPLICIT_TAG_RE = /\\tag\*?\s*\{/

export interface NumberedLatex {
  latex: string
  nextNumber: number
}

/**
 * KaTeX renders each Markdown math node independently, so its built-in
 * equation counter restarts at one for every block. Convert unstarred equation
 * environments to explicit tags while carrying one counter across the note.
 */
export function numberLatexEquationEnvironments(
  latex: string,
  currentNumber = 0
): NumberedLatex {
  let nextNumber = currentNumber
  const numbered = latex.replace(EQUATION_ENVIRONMENT_RE, (_whole, body: string) => {
    nextNumber += 1
    if (EXPLICIT_TAG_RE.test(body)) {
      return `\\begin{equation*}${body}\\end{equation*}`
    }
    return `\\begin{equation*}${body}\\tag{${nextNumber}}\\end{equation*}`
  })
  return { latex: numbered, nextNumber }
}
