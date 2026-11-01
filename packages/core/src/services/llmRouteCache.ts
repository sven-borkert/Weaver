let revision = 0;

export function invalidateLlmRouteCache(): void {
  revision += 1;
}

export function llmRouteCacheRevision(): number {
  return revision;
}
