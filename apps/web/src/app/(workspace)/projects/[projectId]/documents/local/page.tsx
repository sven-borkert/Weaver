import { z } from "zod";
import { LocalDocumentsScreen } from "../_components/LocalDocumentsScreen";

const selectionSchema = z.object({
  folder: z.uuid().optional(),
  document: z.uuid().optional(),
});

export default async function LocalDocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{
    folder?: string | string[];
    document?: string | string[];
  }>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const selection = selectionSchema.safeParse(query);
  return (
    <LocalDocumentsScreen
      projectId={projectId}
      selection={
        selection.success && !(selection.data.folder && selection.data.document)
          ? selection.data
          : null
      }
    />
  );
}
