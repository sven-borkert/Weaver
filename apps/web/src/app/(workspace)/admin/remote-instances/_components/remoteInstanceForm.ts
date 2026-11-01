import { z } from "zod";

// Client-side mirror of the server's createRemoteInstanceInput.
export const remoteInstanceFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  baseUrl: z.string().trim().min(1, "Base URL is required").max(2048),
  enabled: z.boolean(),
});

export type RemoteInstanceFormValues = z.infer<typeof remoteInstanceFormSchema>;

export const remoteInstanceDefaults = (remote?: {
  name: string;
  baseUrl: string;
  enabled: boolean;
}): RemoteInstanceFormValues =>
  remote
    ? { name: remote.name, baseUrl: remote.baseUrl, enabled: remote.enabled }
    : { name: "", baseUrl: "https://", enabled: true };
