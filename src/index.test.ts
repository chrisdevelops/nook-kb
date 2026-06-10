import { expect, test } from "vitest";
import { hello } from "./index.js";

test("scaffold module loads", () => {
  expect(hello()).toBe("mem");
});
