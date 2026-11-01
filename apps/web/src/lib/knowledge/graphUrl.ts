import { MAX_KNOWLEDGE_TYPE_CHARACTERS } from "@weaver/core/knowledge/extraction";

export type GraphUrlState = {
  focusId?: string;
  documentId?: string;
  projectIds: string[];
  entityTypes: string[];
  relationTypes: string[];
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function values(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function firstUuid(value: string | string[] | undefined) {
  return values(value).find((candidate) => UUID_PATTERN.test(candidate));
}

function normalizedUuids(value: string | string[] | undefined, limit: number) {
  return [
    ...new Set(
      values(value).filter((candidate) => UUID_PATTERN.test(candidate)),
    ),
  ]
    .sort()
    .slice(0, limit);
}

function normalizedTypes(value: string | string[] | undefined, limit: number) {
  return [
    ...new Set(
      values(value)
        .map((candidate) => candidate.trim())
        .filter(
          (candidate) =>
            candidate.length > 0 &&
            candidate.length <= MAX_KNOWLEDGE_TYPE_CHARACTERS,
        ),
    ),
  ]
    .sort()
    .slice(0, limit);
}

export function parseGraphUrlState(
  raw: Record<string, string | string[] | undefined>,
  routeProjectId: string,
): GraphUrlState {
  const focusId = firstUuid(raw.focus);
  const projectIds = normalizedUuids(raw.project, 50);

  return {
    focusId,
    documentId: focusId ? undefined : firstUuid(raw.document),
    projectIds: projectIds.length > 0 ? projectIds : [routeProjectId],
    entityTypes: normalizedTypes(raw.entityType, 20),
    relationTypes: normalizedTypes(raw.relationType, 20),
  };
}

export function graphHref(projectId: string, state: GraphUrlState): string {
  const canonical = parseGraphUrlState(
    {
      focus: state.focusId,
      document: state.documentId,
      project: state.projectIds,
      entityType: state.entityTypes,
      relationType: state.relationTypes,
    },
    projectId,
  );
  const params = new URLSearchParams();

  if (canonical.focusId) {
    params.set("focus", canonical.focusId);
  } else if (canonical.documentId) {
    params.set("document", canonical.documentId);
  }
  if (
    canonical.projectIds.length !== 1 ||
    canonical.projectIds[0] !== projectId
  ) {
    for (const scopedProjectId of canonical.projectIds) {
      params.append("project", scopedProjectId);
    }
  }
  for (const entityType of canonical.entityTypes) {
    params.append("entityType", entityType);
  }
  for (const relationType of canonical.relationTypes) {
    params.append("relationType", relationType);
  }

  const query = params.toString();
  const path = `/projects/${encodeURIComponent(projectId)}/graph`;
  return query ? `${path}?${query}` : path;
}
