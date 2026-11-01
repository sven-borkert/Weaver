import { ConnectedAppsCard } from "./_components/ConnectedAppsCard";

export default function ConnectedAppsPage() {
  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-text m-0 text-[20px] font-semibold">
          Connected apps
        </h1>
        <p className="text-text-3 m-0 text-[13px]">
          MCP clients you have allowed to act as you. Revoking a client stops
          its tokens on their next request.
        </p>
      </div>
      <ConnectedAppsCard />
    </div>
  );
}
