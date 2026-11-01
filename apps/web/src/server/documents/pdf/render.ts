import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import { env } from "~/env";
import { createLimiter } from "./limiter";

export class PdfTimeoutError extends Error {}
export class PdfUnavailableError extends Error {}

export type PdfRenderer = {
  render(html: string, options?: { timeoutMs?: number }): Promise<Uint8Array>;
  close(): Promise<void>;
};

export function launchChromium(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    ...(env.WEAVER_CHROMIUM_PATH
      ? { executablePath: env.WEAVER_CHROMIUM_PATH }
      : {}),
    args: env.WEAVER_CHROMIUM_NO_SANDBOX
      ? ["--no-sandbox", "--disable-setuid-sandbox"]
      : [],
  });
}

const FOOTER = `<div style="font: 8pt sans-serif; color: #52647e; width: 100%; text-align: center;">
  <span class="pageNumber"></span> / <span class="totalPages"></span></div>`;

export function createPdfRenderer(
  options: {
    launch?: () => Promise<Browser>;
    timeoutMs?: number;
    maxWaiting?: number;
  } = {},
): PdfRenderer {
  const launch = options.launch ?? launchChromium;
  const timeoutMs = options.timeoutMs ?? env.WEAVER_PDF_TIMEOUT_MS;
  const limiter = createLimiter({
    concurrency: 1,
    maxWaiting: options.maxWaiting ?? 4,
  });
  let browser: Promise<Browser> | null = null;

  const getBrowser = () => {
    if (browser) return browser;
    const launching: Promise<Browser> = launch().then(
      (instance) => {
        // A crashed or killed Chromium is relaunched by the next render.
        instance.on("disconnected", () => {
          if (browser === launching) browser = null;
        });
        return instance;
      },
      (error: unknown) => {
        browser = null;
        throw new PdfUnavailableError(
          error instanceof Error ? error.message : String(error),
        );
      },
    );
    browser = launching;
    return launching;
  };

  return {
    render: (html, renderOptions) =>
      limiter.run(async () => {
        const cap = renderOptions?.timeoutMs ?? timeoutMs;
        const instance = await getBrowser();
        const context = await instance
          .newContext({ javaScriptEnabled: true })
          .catch((error: unknown) => {
            browser = null;
            throw error;
          });
        let timer: NodeJS.Timeout | undefined;
        try {
          await context.route("**/*", (route) => route.abort());
          const page = await context.newPage();
          const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new PdfTimeoutError("PDF render timed out")),
              cap,
            );
          });
          const work = (async () => {
            await page.setContent(html, { waitUntil: "load", timeout: cap });
            await page.waitForFunction(
              () =>
                document.documentElement.getAttribute("data-weaver-ready") ===
                "true",
              undefined,
              { timeout: cap },
            );
            return page.pdf({
              format: "A4",
              printBackground: true,
              margin: {
                top: "20mm",
                right: "20mm",
                bottom: "20mm",
                left: "20mm",
              },
              displayHeaderFooter: true,
              headerTemplate: "<span></span>",
              footerTemplate: FOOTER,
            });
          })();
          return new Uint8Array(await Promise.race([work, deadline]));
        } finally {
          clearTimeout(timer);
          await context.close().catch(() => undefined);
        }
      }),
    close: async () => {
      const instance = await browser?.catch(() => null);
      browser = null;
      await instance?.close().catch(() => undefined);
    },
  };
}

let singleton: PdfRenderer | undefined;
export function getPdfRenderer(): PdfRenderer {
  singleton ??= createPdfRenderer();
  return singleton;
}

const MERMAID_BUNDLE = "node_modules/mermaid/dist/mermaid.min.js";
// Server runtimes start in the app directory, the integration suite in the repository root.
const APP_DIRECTORIES = [".", "apps/web"];

async function readMermaidBundle(): Promise<string> {
  let failure: unknown;
  for (const directory of APP_DIRECTORIES) {
    try {
      return await readFile(path.resolve(directory, MERMAID_BUNDLE), "utf8");
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

let bundle: Promise<string> | undefined;
// Read by path, where next.config's tracing include copies it: the bundler compiles a
// module lookup into a module id.
export function mermaidBundleSource(): Promise<string> {
  bundle ??= readMermaidBundle();
  return bundle;
}
