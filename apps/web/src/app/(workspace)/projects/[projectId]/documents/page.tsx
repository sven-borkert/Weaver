import { parseFolderParam } from "~/lib/explorer/entries";
import { ContentExplorerScreen } from "~/components/explorer/ContentExplorerScreen";
import { documentsExplorerAdapter } from "./_components/documentsExplorerAdapter";

export default async function DocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ folder?: string | string[] }>;
}) {
  const { projectId } = await params;
  const { folder } = await searchParams;
  const folderPath = parseFolderParam(folder);
  return (
    <ContentExplorerScreen
      key={folderPath.join("/")}
      projectId={projectId}
      folderPath={folderPath}
      adapter={documentsExplorerAdapter}
    />
  );
}
