export type ResultArgumentsValidator = (value: unknown) => string[];
export function compileResultValidator(schema: unknown): ResultArgumentsValidator;
export function validatedResultExecution<TExec, TResult>(
  validate: ResultArgumentsValidator,
  ToolArgsError: new (violations: string[]) => Error,
  callbacks: { isActive(exec: TExec): boolean; complete(args: unknown, exec: TExec): TResult },
): (args: unknown, exec: TExec) => TResult;
