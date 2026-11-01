import { APP_BASE_PATH } from "~/lib/basePath";
import { withDocumentBasePath } from "./link-base-path";
import { getSchema, type JSONContent } from "@tiptap/core";
import { renderToReactElement } from "@tiptap/static-renderer/pm/react";
import type { ReactNode } from "react";
import { documentExtensions } from "@weaver/core/editor/extensions";
import { documentHeadingAnchors } from "./document-heading-anchors";

type RenderOptions = NonNullable<
  Parameters<typeof renderToReactElement>[0]["options"]
>;

export type RenderMappings = NonNullable<RenderOptions["nodeMapping"]>;

export function renderDocumentContent(
  content: JSONContent,
  nodeMapping?: RenderMappings,
  basePath = APP_BASE_PATH,
): ReactNode {
  const documentNode = getSchema(documentExtensions()).nodeFromJSON(
    withDocumentBasePath(content, basePath),
  );
  const renderedHeadingAnchors = new Map(
    documentHeadingAnchors(documentNode).map(({ node, anchor }) => [
      node,
      anchor,
    ]),
  );
  const headingMapping: RenderMappings = {
    heading: ({ node, children }) => {
      const level = Math.min(Math.max(Number(node.attrs.level), 1), 6);
      const id = renderedHeadingAnchors.get(node);
      const Heading = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return (
        <Heading id={id} data-document-section="true" tabIndex={-1}>
          {children}
        </Heading>
      );
    },
  };

  return renderToReactElement({
    extensions: documentExtensions(),
    content: documentNode,
    options: { nodeMapping: { ...nodeMapping, ...headingMapping } },
  });
}
