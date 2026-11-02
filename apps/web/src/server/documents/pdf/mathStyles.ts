import { readAppFile } from "./appFiles";

const KATEX_DIST = "node_modules/katex/dist";
const FONT_SOURCE_RE = /src:url\(fonts\/([\w.-]+\.woff2)\)[^;}]*/g;

async function readMathStyles(): Promise<string> {
  const css = (await readAppFile(`${KATEX_DIST}/katex.min.css`)).toString(
    "utf8",
  );
  const names = new Set(
    Array.from(css.matchAll(FONT_SOURCE_RE), (match) => match[1]!),
  );
  const fonts = new Map(
    await Promise.all(
      Array.from(
        names,
        async (name) =>
          [
            name,
            (await readAppFile(`${KATEX_DIST}/fonts/${name}`)).toString(
              "base64",
            ),
          ] as const,
      ),
    ),
  );
  // Chromium blocks every request while printing, so the fonts travel in the page.
  return css.replace(
    FONT_SOURCE_RE,
    (_match, name: string) =>
      `src:url(data:font/woff2;base64,${fonts.get(name)!}) format("woff2")`,
  );
}

let styles: Promise<string> | undefined;
export function mathStylesSource(): Promise<string> {
  styles ??= readMathStyles();
  return styles;
}
