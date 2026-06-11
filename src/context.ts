export type Context = {
  dbPath: string;
  clock: () => Date;
  generateId: () => string;
  /** Path to memory.jsonc; absent means no config file (defaults apply). */
  configPath?: string;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};
