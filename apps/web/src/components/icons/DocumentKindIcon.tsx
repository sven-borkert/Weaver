import { FileText } from "lucide-react";
import type { SVGProps } from "react";
import type { DocumentKind } from "@weaver/core/documents/kinds";
import { PythonIcon } from "./PythonIcon";

export function DocumentKindIcon({
  kind,
  ...props
}: { kind: DocumentKind } & SVGProps<SVGSVGElement>) {
  return kind === "python" ? (
    <PythonIcon {...props} />
  ) : (
    <FileText {...props} />
  );
}
