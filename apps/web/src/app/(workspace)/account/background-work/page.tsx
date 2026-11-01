import { initialBackgroundWorkFilters } from "~/lib/background-work/initialFilters";
import { BackgroundWorkScreen } from "./_components/BackgroundWorkScreen";

export default async function BackgroundWorkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const initial = initialBackgroundWorkFilters(await searchParams);
  return (
    <BackgroundWorkScreen
      key={`${initial.audience}:${initial.projectId}`}
      initial={initial}
    />
  );
}
