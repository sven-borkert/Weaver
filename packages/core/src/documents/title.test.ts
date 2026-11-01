import { expect, it } from "vitest";
import { documentTitleSchema } from "./title";
it.each(["\u2028", "\u2029", "\0"])(
  "rejects title terminator/control %s",
  (character) => {
    expect(documentTitleSchema.safeParse(`Title${character}text`).success).toBe(
      false,
    );
  },
);
