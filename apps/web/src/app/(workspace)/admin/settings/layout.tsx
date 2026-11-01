import { SettingsTabs } from "./_components/SettingsTabs";
export default function AdminSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <h1 className="text-text m-0 text-[20px] font-semibold">Settings</h1>
      <SettingsTabs />
      {children}
    </div>
  );
}
