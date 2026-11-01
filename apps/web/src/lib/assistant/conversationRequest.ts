export function createConversationRequestGuard() {
  let revision = 0;
  return {
    begin: () => ++revision,
    invalidate: () => {
      revision += 1;
    },
    isCurrent: (request: number) => request === revision,
  };
}

export function canStartConversationRun(
  activeId: string | null,
  submittedId: string,
): boolean {
  return activeId === submittedId;
}
