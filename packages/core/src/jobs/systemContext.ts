const knowledgeSystemContextBrand: unique symbol = Symbol(
  "KnowledgeSystemContext",
);

export type KnowledgeSystemContext = Readonly<{
  [knowledgeSystemContextBrand]: true;
}>;

function createKnowledgeSystemContext(): KnowledgeSystemContext {
  return Object.freeze({ [knowledgeSystemContextBrand]: true });
}

export function createKnowledgeSystemContextForRuntime(): KnowledgeSystemContext {
  return createKnowledgeSystemContext();
}

export function knowledgeSystemContextForTests(): KnowledgeSystemContext {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "KnowledgeSystemContext is only available to tests in the test runtime",
    );
  }
  return createKnowledgeSystemContext();
}
