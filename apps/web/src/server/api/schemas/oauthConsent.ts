import { z } from "zod";

export const oauthConsentIdInput = z.object({ consentId: z.uuid() });
