import { ConnectionDetailScreen } from "../_components/ConnectionDetailScreen";

export const metadata = { title: "MCP connection · Account · Weaver" };

export default async function McpConnectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ connectionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { connectionId } = await params;
  const { discover } = await searchParams;
  return (
    <ConnectionDetailScreen
      connectionId={connectionId}
      autoDiscover={discover === "1"}
    />
  );
}
