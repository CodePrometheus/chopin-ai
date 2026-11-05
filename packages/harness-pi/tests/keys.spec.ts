import { describe, expect, it } from "vitest";
import { createDataKey, PASSPHRASE_ITERATIONS, rewrapDataKey, serviceKey, unwrapDataKey, WrongSecret, type WrappedKey } from "../src/keys.js";

describe("data keys", () => {
  it("wraps a new key by a passphrase and a recovery key, either of which opens it into a key that cannot be read out", async () => {
    const made = await createDataKey("correct horse battery staple");
    expect(made.key.extractable).toBe(false);
    expect(made.byPassphrase).toMatchObject({ version: 1, by: "passphrase", iterations: PASSPHRASE_ITERATIONS });
    expect(made.recoveryKey).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{8}){7}$/);
    // What a service opens with is derived from the key, the same however the key was opened, and is not the key.
    const derived = await serviceKey(made.key);
    expect(derived).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await serviceKey(await unwrapDataKey(made.byPassphrase, "correct horse battery staple"))).toBe(derived);
    // A recovery key reads back as written down, in any case, with spaces for dashes.
    const written = made.recoveryKey.toUpperCase().replace(/-/g, " ");
    const recovered = await unwrapDataKey(made.byRecovery, written);
    expect(recovered.extractable).toBe(false);
    expect(await serviceKey(recovered)).toBe(derived);
    // Wrapped keys are JSON, as an integrator keeps them.
    expect(JSON.parse(JSON.stringify(made.byPassphrase))).toEqual(made.byPassphrase);
  });

  it("refuses a wrong passphrase or recovery key, and a wrapped key passed off as wrapped by the other", async () => {
    const made = await createDataKey("first passphrase");
    await expect(unwrapDataKey(made.byPassphrase, "second passphrase")).rejects.toThrow(WrongSecret);
    await expect(unwrapDataKey(made.byRecovery, made.recoveryKey.replace(/^./, (digit) => (digit === "0" ? "1" : "0")))).rejects.toThrow(WrongSecret);
    await expect(unwrapDataKey(made.byRecovery, "not a recovery key")).rejects.toThrow(WrongSecret);
    const swapped: WrappedKey = { version: 1, by: "recovery", iv: made.byPassphrase.iv, data: made.byPassphrase.data };
    await expect(unwrapDataKey(swapped, made.recoveryKey)).rejects.toThrow(WrongSecret);
    // A count no client should spend its time on is no wrapped key.
    await expect(unwrapDataKey({ ...made.byPassphrase, iterations: 1e12 } as WrappedKey, "first passphrase")).rejects.toThrow("no wrapped data key");
    await expect(createDataKey("")).rejects.toThrow("cannot be empty");
  });

  it("wraps the key anew by a new passphrase, opened with the old one or the recovery key", async () => {
    const made = await createDataKey("old passphrase");
    const derived = await serviceKey(made.key);
    const changed = await rewrapDataKey(made.byPassphrase, "old passphrase", "new passphrase");
    expect(changed).toMatchObject({ by: "passphrase" });
    expect(changed).not.toEqual(made.byPassphrase);
    expect(await serviceKey(await unwrapDataKey(changed, "new passphrase"))).toBe(derived);
    await expect(unwrapDataKey(changed, "old passphrase")).rejects.toThrow(WrongSecret);
    const reset = await rewrapDataKey(made.byRecovery, made.recoveryKey, "after recovery");
    expect(await serviceKey(await unwrapDataKey(reset, "after recovery"))).toBe(derived);
    await expect(rewrapDataKey(made.byPassphrase, "wrong", "new passphrase")).rejects.toThrow(WrongSecret);
  });

  it("reads a passphrase typed on any device as the same", async () => {
    // Composed and decomposed accents, and full-width letters, are one passphrase each way they are typed.
    const made = await createDataKey("café ｐａｓｓ");
    expect(await serviceKey(await unwrapDataKey(made.byPassphrase, "café pass"))).toBe(await serviceKey(made.key));
  });
});
