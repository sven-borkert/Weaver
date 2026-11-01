import { callbackNotice } from "./_components/callbackNotice";
import { RemoteInstancesCard } from "./_components/RemoteInstancesCard";

function stringParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function RemoteInstancesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const notice = callbackNotice({
    connected: stringParam(params.connected),
    error: stringParam(params.error),
  });
  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-text m-0 text-[20px] font-semibold">
          Remote instances
        </h1>
        <p className="text-text-3 m-0 text-[13px]">
          Connect your account to other Weaver instances to send documents and
          tables there.
        </p>
      </div>
      <RemoteInstancesCard notice={notice} />
    </div>
  );
}
