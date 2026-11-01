import { MyTasksCard } from "./_components/MyTasksCard";

export default function MyTasksPage() {
  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-text m-0 text-[20px] font-semibold">Tasks</h1>
        <p className="text-text-3 m-0 text-[13px]">
          Scheduled AI tasks you own, across your projects. They run as you and
          keep one report document each.
        </p>
      </div>
      <MyTasksCard />
    </div>
  );
}
