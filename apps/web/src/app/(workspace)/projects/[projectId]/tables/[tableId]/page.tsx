import { TableScreen } from "../_components/TableScreen";

export default async function TablePage({
  params,
}: {
  params: Promise<{ projectId: string; tableId: string }>;
}) {
  const { projectId, tableId } = await params;
  return <TableScreen key={tableId} projectId={projectId} tableId={tableId} />;
}
