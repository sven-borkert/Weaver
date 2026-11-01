import { expect, test } from "@playwright/test";
import { login, logout, openNewProjectDialog, mcpClient } from "./helpers";

test.describe("exams", () => {
  test.describe.configure({ mode: "serial" });
  test("a trainee reloads saved answers and receives a trainer-reviewed MCP grade", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await login(page, "owner@weaver.local");
    await openNewProjectDialog(page);
    await page
      .getByRole("dialog", { name: "New project" })
      .getByLabel("Name")
      .fill("Exams E2E");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Exams E2E" }),
    ).toBeVisible();
    const projectId = new URL(page.url()).pathname.split("/")[2]!;
    await page.goto(`/projects/${projectId}/settings`);
    await page.getByRole("button", { name: "Add member" }).click();
    const add = page.getByRole("dialog", { name: "Add member" });
    await add.getByLabel("Email").fill("viewer@weaver.local");
    await add.getByLabel("Role", { exact: true }).click();
    await page.getByRole("option", { name: "Viewer", exact: true }).click();
    await add.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByLabel("Training for viewer@weaver.local").click();
    await page.getByRole("option", { name: "Trainee", exact: true }).click();
    await page.getByLabel("Training for owner@weaver.local").click();
    await page.getByRole("option", { name: "Trainer", exact: true }).click();
    await page.getByRole("link", { name: "Exams", exact: true }).click();
    await page.getByRole("button", { name: "New exam" }).click();
    await page.getByLabel("Title", { exact: true }).fill("Safety basics");
    await page.getByLabel("Time limit (minutes)", { exact: true }).fill("5");
    await page
      .getByRole("button", { name: "Create exam", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add multiple-choice question" })
      .click();
    await page
      .getByLabel("Prompt", { exact: true })
      .fill("Which response is safe?\n\n```python\nstop_machine()\n```");
    await page.getByLabel("Weight", { exact: true }).fill("2");
    await page.getByLabel("Choice 1", { exact: true }).fill("Stop the machine");
    await page.getByLabel("Choice 2", { exact: true }).fill("Keep running");
    await page.getByRole("button", { name: "Add free-text question" }).click();
    await page
      .getByLabel("Prompt", { exact: true })
      .nth(1)
      .fill("Explain the safe response.");
    await page.getByLabel("Weight", { exact: true }).nth(1).fill("3");
    await page
      .getByLabel("Expected answer", { exact: true })
      .nth(1)
      .fill("Stop the machine and inform the supervisor.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Exam saved", { exact: true })).toBeVisible();
    // Only the shell's main region scrolls; the document must not grow.
    const documentScroll = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    }));
    expect(documentScroll.scrollHeight).toBeLessThanOrEqual(
      documentScroll.clientHeight,
    );
    const examId = new URL(page.url()).pathname.split("/").at(-1)!;
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Publish", exact: true }),
    ).toHaveCount(0);
    await logout(page);
    await login(page, "viewer@weaver.local");
    await page.goto(`/projects/${projectId}/exams`);
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Start", exact: true })
      .click();
    await page
      .getByRole("button", { name: "View code example (python)" })
      .click();
    const codeExample = page.getByRole("dialog", { name: "Code example" });
    await expect(codeExample.locator("code")).toHaveText("stop_machine()");
    await codeExample
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.getByRole("radio", { name: "Stop the machine" }).check();
    await page
      .getByLabel("Your answer")
      .fill("Stop the machine and inform the supervisor.");
    await expect(page.getByText(/All changes saved/)).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("radio", { name: "Stop the machine" }),
    ).toBeChecked();
    await expect(page.getByLabel("Your answer")).toHaveValue(
      "Stop the machine and inform the supervisor.",
    );
    const attemptUrl = page.url();
    const attemptId = new URL(attemptUrl).pathname.split("/").at(-1)!;
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await page
      .getByRole("button", { name: "Submit exam", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Waiting for grading" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Back to results" }).click();
    await expect(
      page.getByRole("table", { name: "Your exam results" }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: /Open attempt: Safety basics/ })
      .click();
    await expect(
      page.getByRole("heading", { name: "Waiting for grading" }),
    ).toBeVisible();
    await logout(page);
    await login(page, "owner@weaver.local");
    await page.goto("/account/api-keys");
    await page.getByRole("button", { name: "Create key" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Exam grader");
    await page.getByLabel("Edit content directly, without review").check();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const secret = await page
      .getByRole("textbox", { name: "New API key" })
      .inputValue();
    await page.getByRole("button", { name: "I have copied the key" }).click();
    const client = await mcpClient(secret);
    try {
      const listed = await client.callTool({
        name: "list_exam_attempts",
        arguments: { projectId },
      });
      expect(JSON.stringify(listed)).toContain(attemptId);
      await page.goto(`/projects/${projectId}/exams/${examId}`);
      const review = await client.callTool({
        name: "get_exam_attempt",
        arguments: { attemptId },
      });
      const body = review.structuredContent as {
        attempt: { revision: number };
        questions: Array<{ question: { id: string; kind: string } }>;
      };
      const attempt = body.attempt;
      const free = body.questions.find(
        (q) => q.question.kind === "free_text",
      )!.question;
      const proposed = await client.callTool({
        name: "grade_exam_attempt",
        arguments: {
          attemptId,
          expectedRevision: attempt.revision,
          grades: [
            {
              questionId: free.id,
              score: 3,
              rationale: "Correct shutdown and escalation.",
            },
          ],
          idempotencyKey: `e2e-grade-${Date.now()}`,
        },
      });
      expect(proposed.isError).not.toBe(true);
      await page.goto(`/projects/${projectId}/exams/results`);
      await page.getByLabel("Show", { exact: true }).selectOption("in_review");
      await page
        .getByRole("link", { name: /Review grade: Safety basics/ })
        .click();
      await expect(page.getByText(/via API key/)).toBeVisible();
      await expect(page.getByLabel("Rationale").nth(1)).toHaveValue(
        "Correct shutdown and escalation.",
      );
      await page
        .getByRole("button", { name: "Release to trainee", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Release", exact: true })
        .click();
      await expect(page.getByText(/Released by/)).toBeVisible();
      await page
        .getByRole("button", { name: "View code example (python)" })
        .click();
      await expect(codeExample.locator("code")).toHaveText("stop_machine()");
      await codeExample
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await logout(page);
      await login(page, "viewer@weaver.local");
      await page
        .getByRole("button", { name: /Background work:.*1 unseen results/ })
        .click();
      await page.getByRole("link", { name: /Open Safety basics/ }).click();
      await expect(
        page.getByRole("heading", { name: "5 / 5 (100 %)" }),
      ).toBeVisible();
      await expect(
        page.getByText("Correct shutdown and escalation."),
      ).toBeVisible();
      await page.getByRole("link", { name: "Back to results" }).click();
      await page
        .getByRole("link", { name: /View result: Safety basics/ })
        .click();
      await page.getByRole("button", { name: "Start new attempt" }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Start", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: /Attempt 2/ }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Submit", exact: true }).click();
      await page
        .getByRole("button", { name: "Submit exam", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Waiting for grading" }),
      ).toBeVisible();
      const current = await client.callTool({
        name: "get_exam",
        arguments: { examId },
      });
      const currentExam = (
        current.structuredContent as { exam: { revision: number } }
      ).exam;
      const archived = await client.callTool({
        name: "update_exam",
        arguments: {
          examId,
          expectedRevision: currentExam.revision,
          status: "archived",
          idempotencyKey: `e2e-archive-${Date.now()}`,
        },
      });
      expect(archived.isError).not.toBe(true);
      await page.goto(`/projects/${projectId}/exams`);
      await expect(page.getByText("Closed", { exact: true })).toBeVisible();
    } finally {
      await client.close();
    }
  });
});
