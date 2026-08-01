import { z } from "zod";
import type { TrainingProviderCapabilities } from "./capabilities.js";

export const desktopDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Ed25519 public key, base64url raw format. Private key never leaves the device keychain. */
  publicKey: z.string(),
  platform: z.enum(["macos", "windows", "linux"]),
  appVersion: z.string(),
  bridgeVersion: z.string().optional(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  revokedAt: z.string().nullable().optional(),
  capabilities: z.custom<TrainingProviderCapabilities>().optional(),
  bridgePaused: z.boolean().default(false),
});
export type DesktopDevice = z.infer<typeof desktopDeviceSchema>;
