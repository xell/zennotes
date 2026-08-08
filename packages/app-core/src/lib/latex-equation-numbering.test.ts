import { describe, expect, it } from 'vitest'
import { numberLatexEquationEnvironments } from './latex-equation-numbering'

describe('LaTeX equation numbering', () => {
  it('numbers equation environments from the supplied document counter', () => {
    const first = numberLatexEquationEnvironments(
      String.raw`\begin{equation}a=b\end{equation}`,
      0
    )
    const second = numberLatexEquationEnvironments(
      String.raw`\begin{equation}c=d\end{equation}`,
      first.nextNumber
    )

    expect(first.latex).toContain(String.raw`\tag{1}`)
    expect(second.latex).toContain(String.raw`\tag{2}`)
    expect(second.nextNumber).toBe(2)
  })

  it('numbers every equation environment in one math block', () => {
    const result = numberLatexEquationEnvironments(
      String.raw`\begin{equation}a\end{equation}\begin{equation}b\end{equation}`,
      3
    )

    expect(result.latex).toContain(String.raw`a\tag{4}`)
    expect(result.latex).toContain(String.raw`b\tag{5}`)
    expect(result.nextNumber).toBe(5)
  })

  it('leaves starred and non-equation environments unnumbered', () => {
    const latex = String.raw`\begin{equation*}a\end{equation*}\begin{align}b\end{align}`
    expect(numberLatexEquationEnvironments(latex, 2)).toEqual({
      latex,
      nextNumber: 2
    })
  })

  it('preserves an explicit tag and still advances the document counter', () => {
    const result = numberLatexEquationEnvironments(
      String.raw`\begin{equation}a=b\tag{A}\end{equation}`,
      3
    )

    expect(result.latex).toContain(String.raw`\tag{A}`)
    expect(result.latex).not.toContain(String.raw`\tag{4}`)
    expect(result.nextNumber).toBe(4)
  })
})
