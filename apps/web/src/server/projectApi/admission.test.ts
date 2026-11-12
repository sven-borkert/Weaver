import { expect, it } from "vitest";
import { createProjectApiAdmission } from "./admission";

it("recognizes only verified exact credentials and expires or forgets recognition", () => {
  const admission = createProjectApiAdmission();
  admission.check("Bearer valid", "nat", 0).verified();
  for (let i = 0; i < 239; i++) admission.check(`Bearer forged-${i}`, "nat", 1);
  expect(() => admission.check("Bearer forged-next", "nat", 2)).toThrow(
    "Rate limit exceeded",
  );
  const known = admission.check("Bearer valid", "nat", 2);
  known.rejected();
  expect(() => admission.check("Bearer valid", "nat", 3)).toThrow(
    "Rate limit exceeded",
  );
  admission.check("Bearer valid", "nat", 60_001).verified();
  for (let i = 0; i < 240; i++)
    admission.check(`Bearer newer-${i}`, "nat", 120_002);
  expect(() => admission.check("Bearer valid", "nat", 120_003)).toThrow(
    "Rate limit exceeded",
  );
});
