"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useMounted } from "~/lib/use-mounted";

import { Button } from "~/components/ui/button";

const THEME_ORDER = ["system", "light", "dark"] as const;
type ThemeName = (typeof THEME_ORDER)[number];

const ICONS: Record<ThemeName, typeof Sun> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

export function ThemeToggle() {
  const mounted = useMounted();
  const { theme, setTheme } = useTheme();

  const current: ThemeName =
    mounted && (theme === "light" || theme === "dark") ? theme : "system";
  const next =
    THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length] ??
    "system";
  const Icon = ICONS[current];

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Theme: ${current}. Click to switch`}
      title={`Theme: ${current}`}
      // Not `disabled`: Firefox restores a button's enabled state across reloads,
      // which would make the attribute mismatch during hydration.
      onClick={() => {
        if (mounted) setTheme(next);
      }}
    >
      <Icon className="size-4" />
    </Button>
  );
}
