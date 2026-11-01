import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FolderDownloadButton } from "./FolderDownloadButton";

describe("FolderDownloadButton", () => {
  it("links to the archive and lets the server name the file", () => {
    const html = renderToStaticMarkup(
      <FolderDownloadButton
        href="/api/projects/p1/folders/archive?path=notes"
        folderName="My notes"
      />,
    );

    expect(html).toContain(
      'href="/api/projects/p1/folders/archive?path=notes"',
    );
    expect(html).toContain('download=""');
    expect(html).toContain('aria-label="Download My notes as ZIP"');
    expect(html).toContain("Download as ZIP");
  });
});
