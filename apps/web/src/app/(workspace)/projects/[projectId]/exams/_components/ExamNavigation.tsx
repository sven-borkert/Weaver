import Link from "next/link";
import { Button } from "~/components/ui/button";
export function ExamNavigation({
  projectId,
  active,
}: {
  projectId: string;
  active: "exams" | "results";
}) {
  const base = `/projects/${projectId}/exams`;
  return (
    <nav aria-label="Exam pages" className="flex gap-2">
      <Button asChild variant={active === "exams" ? "secondary" : "outline"}>
        <Link
          href={base}
          aria-current={active === "exams" ? "page" : undefined}
        >
          Exams
        </Link>
      </Button>
      <Button asChild variant={active === "results" ? "secondary" : "outline"}>
        <Link
          href={`${base}/results`}
          aria-current={active === "results" ? "page" : undefined}
        >
          Results
        </Link>
      </Button>
    </nav>
  );
}
