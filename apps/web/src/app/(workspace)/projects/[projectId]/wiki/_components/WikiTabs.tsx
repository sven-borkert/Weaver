import Link from "next/link";

export function WikiTabs({
  projectId,
  active,
}: {
  projectId: string;
  active: "input" | "runs";
}) {
  const tab = (name: "input" | "runs", label: string, href: string) => (
    <Link
      href={href}
      aria-current={active === name ? "page" : undefined}
      className={`border-b-2 px-3 py-2 text-[13px] font-medium ${
        active === name
          ? "border-primary text-text"
          : "text-text-2 hover:text-text border-transparent"
      }`}
    >
      {label}
    </Link>
  );
  return (
    <nav
      aria-label="Wiki sections"
      className="border-line flex gap-1 border-b px-6"
    >
      {tab("input", "Input", `/projects/${projectId}/wiki`)}
      {tab("runs", "Runs", `/projects/${projectId}/wiki/runs`)}
    </nav>
  );
}
