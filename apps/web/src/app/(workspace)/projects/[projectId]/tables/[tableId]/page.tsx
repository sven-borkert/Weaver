import { TableScreen } from "../_components/TableScreen";

export default async function TablePage({
  params,
}: {
  params: Promise<{ projectId: string; tableId: string }>;
}) {
  const { projectId, tableId } = await params;
  return <TableScreen projectId={projectId} tableId={tableId} />;
}
