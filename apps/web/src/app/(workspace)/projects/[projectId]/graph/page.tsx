import { parseGraphUrlState } from "~/lib/knowledge/graphUrl";
import { GraphScreen } from "./_components/GraphScreen";

export default async function GraphPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId }, rawSearchParams] = await Promise.all([
    params,
    searchParams,
  ]);
  return (
    <GraphScreen
      key={projectId}
      projectId={projectId}
      urlState={parseGraphUrlState(rawSearchParams, projectId)}
    />
  );
}
