import { DocumentScreen } from "../_components/DocumentScreen";
import {
  parseDocumentSectionNavigation,
  parseDocumentVersion,
} from "~/lib/documents/section-navigation";

export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; documentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId, documentId }, rawSearchParams] = await Promise.all([
    params,
    searchParams,
  ]);
  return (
    <DocumentScreen
      key={documentId}
      projectId={projectId}
      documentId={documentId}
      sectionNavigation={parseDocumentSectionNavigation(rawSearchParams)}
      initialVersionSha={parseDocumentVersion(rawSearchParams)}
    />
  );
}
