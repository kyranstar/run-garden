/** The bridge-side password login: hashes with node's md5 and delegates to
 * the shared client's loginWithHash — the shared module runs on Workers,
 * where MD5 isn't available, so hashing lives at this edge. */
import { createHash } from "node:crypto";
import type { CorosClient } from "@rg/coros";

export async function loginWithPassword(
  client: CorosClient,
  email: string,
  password: string,
): Promise<{ userId: string }> {
  const pwdMd5 = createHash("md5").update(password, "utf8").digest("hex");
  return client.loginWithHash(email, pwdMd5);
}
