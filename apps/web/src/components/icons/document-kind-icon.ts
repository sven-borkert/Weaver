import { FileText } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import type { DocumentKind } from "@weaver/core/documents/kinds";
import { PythonIcon } from "./PythonIcon";

export type DocumentIconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export function documentKindIcon(kind: DocumentKind): DocumentIconComponent {
  return kind === "python" ? PythonIcon : FileText;
}
