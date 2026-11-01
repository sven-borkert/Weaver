import { withReference } from "@weaver/core/diagnostics/reference";

export function publicErrorShape<
  T extends { message: string; data: { httpStatus: number; stack?: string } },
>(shape: T, isDev: boolean, reference: string | null = null): T {
  if (shape.data.httpStatus < 500) return shape;
  const message = withReference(
    isDev ? shape.message : "An unexpected server error occurred",
    reference,
  );
  return {
    ...shape,
    message,
    data: { ...shape.data, stack: isDev ? shape.data.stack : undefined },
  };
}
