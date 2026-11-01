import { ContentExplorerScreen } from "~/components/explorer/ContentExplorerScreen";
import { parseFolderParam } from "~/lib/explorer/entries";
import { tablesExplorerAdapter } from "./_components/tablesExplorerAdapter";

export default async function TablesPage({
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
      adapter={tablesExplorerAdapter}
    />
  );
}
