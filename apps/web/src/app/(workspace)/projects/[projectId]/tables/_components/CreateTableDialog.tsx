"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Table2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { invalidateTableCaches } from "~/lib/tables/table-cache-invalidation";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api } from "~/trpc/react";
import { TableFolderPicker } from "./TableFolderPicker";

/** Client-side mirror of the server's table.create title field. */
const createTableFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Enter a title")
    .max(200, "Title must be at most 200 characters")
    .refine((value) => !/[\r\n]/.test(value), {
      message: "Title must be a single line",
    }),
});

type CreateTableFormValues = z.infer<typeof createTableFormSchema>;

const defaultValues: CreateTableFormValues = { title: "" };

type CreateTableDialogProps = {
  projectId: string;
  folderPath: string[];
  folders: string[];
  folderNames?: Record<string, string>;
};

export function CreateTableDialog({
  projectId,
  folderPath: defaultFolderPath,
  folders,
  folderNames,
}: CreateTableDialogProps) {
  const router = useRouter();
  const utils = api.useUtils();
  const [open, setOpen] = useState(false);
  const [folderPath, setFolderPath] = useState(defaultFolderPath);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors },
  } = useForm<CreateTableFormValues>({
    resolver: zodResolver(createTableFormSchema),
    defaultValues,
  });

  const createTable = api.table.create.useMutation({
    onSuccess: async (table) => {
      await invalidateTableCaches(utils, projectId, table.id);
      toast.success("Table created");
      setOpen(false);
      reset(defaultValues);
      router.push(`/projects/${projectId}/tables/${table.id}`);
    },
    onError: (err) => {
      if (err.data?.field) {
        applyTrpcErrorToForm(err, (name, error) =>
          setError(name as Parameters<typeof setError>[0], error),
        );
      } else {
        toast.error("Could not create the table");
      }
    },
  });

  const onSubmit = handleSubmit((values) => {
    createTable.mutate({ projectId, folderPath, title: values.title });
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (createTable.isPending) return;
        if (nextOpen) {
          createTable.reset();
          setFolderPath(defaultFolderPath);
        }
        setOpen(nextOpen);
        if (!nextOpen) reset(defaultValues);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Table2 data-icon="inline-start" aria-hidden="true" />
          New table
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={!createTable.isPending}
        aria-busy={createTable.isPending}
      >
        <DialogHeader>
          <DialogTitle>New table</DialogTitle>
          <DialogDescription>
            Create a table and choose where it belongs.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-3"
          aria-busy={createTable.isPending}
          noValidate
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-table-title">Title</Label>
            <Input
              id="create-table-title"
              autoFocus
              disabled={createTable.isPending}
              placeholder="Untitled table"
              aria-invalid={errors.title ? true : undefined}
              aria-describedby={
                errors.title ? "create-table-title-error" : undefined
              }
              {...register("title")}
            />
            {errors.title ? (
              <p
                id="create-table-title-error"
                role="alert"
                className="text-danger m-0 text-[12px]"
              >
                {errors.title.message}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-table-folder">Folder</Label>
            <TableFolderPicker
              folderNames={folderNames}
              id="create-table-folder"
              folders={folders}
              value={folderPath}
              onValueChange={setFolderPath}
              disabled={createTable.isPending}
              label="Table folder"
            />
          </div>
          {createTable.error && !createTable.error.data?.field ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              Could not create the table. Try again.
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                disabled={createTable.isPending}
              >
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={createTable.isPending}
              aria-busy={createTable.isPending}
            >
              {createTable.isPending ? "Creating…" : "Create table"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
