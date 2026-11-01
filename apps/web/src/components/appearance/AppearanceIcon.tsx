"use client";

import {
  BookOpen,
  Briefcase,
  Calendar,
  CircleCheck,
  Code,
  Database,
  File,
  FileText,
  Folder,
  Heart,
  Lightbulb,
  Star,
  Table2,
  Tag,
  type LucideIcon,
} from "lucide-react";
import { useState, type ComponentType, type SVGProps } from "react";
import type {
  Appearance,
  BuiltinIconName,
  ImageIcon,
} from "@weaver/core/appearance/metadata";
import { withBasePath } from "~/lib/basePath";

export const builtinIcons: Record<BuiltinIconName, LucideIcon> = {
  folder: Folder,
  "file-text": FileText,
  table: Table2,
  "book-open": BookOpen,
  briefcase: Briefcase,
  calendar: Calendar,
  "check-circle": CircleCheck,
  code: Code,
  database: Database,
  file: File,
  heart: Heart,
  lightbulb: Lightbulb,
  star: Star,
  tag: Tag,
};

export function appearanceIconUrl(
  projectId: string,
  icon: ImageIcon,
  revision?: string,
): string {
  const url = withBasePath(
    `/api/projects/${encodeURIComponent(projectId)}/icons/${icon.digest}.${icon.extension}`,
  );
  return revision ? `${url}?at=${encodeURIComponent(revision)}` : url;
}

export function AppearanceIcon({
  appearance,
  fallback: Fallback,
  size,
  projectId,
}: {
  appearance: Appearance | null | undefined;
  fallback: ComponentType<SVGProps<SVGSVGElement>>;
  size: number;
  projectId: string;
}) {
  const icon = appearance?.icon;
  const source =
    icon?.type === "image" ? appearanceIconUrl(projectId, icon) : undefined;
  const [failedSource, setFailedSource] = useState<string>();
  const style = { width: size, height: size, flexShrink: 0 };
  if (icon?.type === "image" && source !== failedSource)
    return (
      // eslint-disable-next-line @next/next/no-img-element -- Authenticated Git assets retain their dedicated serving route.
      <img
        src={source}
        alt=""
        draggable={false}
        aria-hidden="true"
        style={style}
        className="object-contain"
        onError={() => setFailedSource(source)}
      />
    );
  if (icon?.type === "emoji")
    return (
      <span
        aria-hidden="true"
        style={{ ...style, fontSize: size * 0.8, lineHeight: `${size}px` }}
      >
        {icon.value}
      </span>
    );
  const Icon = icon?.type === "builtin" ? builtinIcons[icon.name] : Fallback;
  const fallbackName =
    Object.entries(builtinIcons).find(
      ([, component]) => component === Fallback,
    )?.[0] ?? "default";
  return (
    <Icon
      aria-hidden="true"
      style={style}
      data-fallback={icon?.type === "builtin" ? undefined : fallbackName}
    />
  );
}
