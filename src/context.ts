export type Context = {
  dbPath: string;
  clock: () => Date;
  generateId: () => string;
  /** Path to memory.jsonc; absent means no config file (defaults apply). */
  configPath?: string;
  /** Stdin contents for --body-stdin; the binary reads process.stdin. */
  stdin?: string;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};
