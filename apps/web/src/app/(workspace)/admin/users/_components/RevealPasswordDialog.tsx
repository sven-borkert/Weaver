"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";

// Reset-password wrapper; creation reuses the content in its existing dialog.
export function RevealPasswordDialog({
  password,
  title,
  description,
  onClose,
}: {
  password: string | null;
  title: string;
  description: string;
  onClose: () => void;
}) {
  return (
    <Dialog open={Boolean(password)}>
      <DialogContent showCloseButton={false}>
        {password ? (
          <RevealPasswordContent
            password={password}
            title={title}
            description={description}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function RevealPasswordContent({
  password,
  title,
  description,
  onClose,
}: {
  password: string;
  title: string;
  description: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function close() {
    setCopied(false);
    onClose();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <Label htmlFor="revealed-password">Password</Label>
        <div className="flex gap-2">
          <Input
            id="revealed-password"
            autoFocus
            readOnly
            value={password}
            className="font-mono text-[12px]"
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button
            type="button"
            variant="outline"
            aria-label="Copy password"
            onClick={() => {
              if (!navigator.clipboard) {
                toast.error(
                  "Copy failed — select the password and copy manually",
                );
                return;
              }
              void navigator.clipboard
                .writeText(password)
                .then(() => setCopied(true))
                .catch(() =>
                  toast.error(
                    "Copy failed — select the password and copy manually",
                  ),
                );
            }}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
      </div>
      <DialogFooter>
        <Button type="button" onClick={close}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
