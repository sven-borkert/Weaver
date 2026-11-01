import {
  MAX_KNOWLEDGE_HEADING_COMPONENT_CHARACTERS,
  MAX_KNOWLEDGE_HEADING_DEPTH,
} from "./chunking";

export const MAX_SEARCH_ALIASES = 20;
export const MAX_SEARCH_ALIAS_CHARACTERS = 200;

export function boundSearchHeadingPath(values: string[]): string[] {
  return values
    .slice(0, MAX_KNOWLEDGE_HEADING_DEPTH)
    .map((value) => value.slice(0, MAX_KNOWLEDGE_HEADING_COMPONENT_CHARACTERS));
}

export function boundSearchAliases(values: string[]): string[] {
  return values
    .slice(0, MAX_SEARCH_ALIASES)
    .map((value) => value.slice(0, MAX_SEARCH_ALIAS_CHARACTERS));
}
