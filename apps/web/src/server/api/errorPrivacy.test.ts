import { expect, it } from "vitest";
import { publicErrorShape } from "./errorPrivacy";
it("redacts internal messages and metadata while preserving client validation errors", () => {
  const shape = {
    message: "Prisma /private/path",
    data: {
      httpStatus: 500,
      stack: "secret stack",
      code: "INTERNAL_SERVER_ERROR",
    },
  };
  expect(publicErrorShape(shape, false)).toEqual({
    message: "An unexpected server error occurred",
    data: { httpStatus: 500, code: "INTERNAL_SERVER_ERROR", stack: undefined },
  });
  expect(
    publicErrorShape(
      { ...shape, data: { ...shape.data, httpStatus: 400 } },
      false,
    ).message,
  ).toBe(shape.message);
});
it("appends the diagnostic reference to internal errors only", () => {
  const shape = {
    message: "Prisma /private/path",
    data: { httpStatus: 500, stack: "s", code: "INTERNAL_SERVER_ERROR" },
  };
  expect(publicErrorShape(shape, false, "a3f9c2e1").message).toBe(
    "An unexpected server error occurred (ref a3f9c2e1)",
  );
  expect(publicErrorShape(shape, true, "a3f9c2e1").message).toBe(
    "Prisma /private/path (ref a3f9c2e1)",
  );
  expect(publicErrorShape(shape, false, null).message).toBe(
    "An unexpected server error occurred",
  );
  expect(
    publicErrorShape(
      { ...shape, data: { ...shape.data, httpStatus: 404 } },
      false,
      "a3f9c2e1",
    ).message,
  ).toBe("Prisma /private/path");
});
