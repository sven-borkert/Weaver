/** One value per process, shared by every bundled copy of a module. */
export function processSingleton<T>(name: string, create: () => T): T {
  const key = Symbol.for(`weaver.diagnostics.${name}`);
  const holder = globalThis as typeof globalThis & Record<symbol, unknown>;
  if (!(key in holder)) holder[key] = create();
  return holder[key] as T;
}
