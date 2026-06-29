declare module 'node-pty' {
  interface IPtyForkOptions {
    name?: string
    cols?: number
    rows?: number
    cwd?: string
    env?: Record<string, string>
    encoding?: string | null
  }

  interface IPty {
    readonly pid: number
    onData(listener: (data: string) => void): void
    onExit(listener: (e: { exitCode: number; signal?: number }) => void): void
    write(data: string): void
    resize(columns: number, rows: number): void
    kill(signal?: string): void
  }

  function spawn(file: string, args: string[] | string, options: IPtyForkOptions): IPty
}
