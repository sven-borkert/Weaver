import { createPinnedFetch } from "@weaver/config/outboundFetch";

import type { ProviderAdapterConfig } from "./adapter";
import { boundedJsonRequest, isRecord, validationError } from "./http";
import { bearerHeaders } from "./openaiCompatible";

const MAX_ENDPOINT_RESPONSE_BYTES = 256 * 1_024;
const MAX_UPSTREAM_PROVIDERS = 500;
const MODEL_ID_PATTERN = /^(~?[a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._:-]*)$/i;
const PROVIDER_SLUG_PATTERN = /^[a-z0-9]+(?:[-_/][a-z0-9]+)*$/i;

export type OpenRouterUpstreamProvider = { label: string; slug: string };

export async function listOpenRouterUpstreamProviders(
  config: ProviderAdapterConfig,
  modelId: string,
  fetchImpl: typeof fetch = createPinnedFetch(),
): Promise<OpenRouterUpstreamProvider[]> {
  const match = MODEL_ID_PATTERN.exec(modelId);
  if (!match || match[2] === "." || match[2] === "..") {
    throw validationError("Invalid OpenRouter model id");
  }

  const apiKey = await config.resolveCredential();
  const { body } = await boundedJsonRequest({
    fetchImpl,
    url: `${config.baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(match[1]!)}/${encodeURIComponent(match[2]!)}/endpoints`,
    method: "GET",
    headers: bearerHeaders(apiKey),
    timeoutMs: config.requestTimeoutMs,
    maxResponseBytes: MAX_ENDPOINT_RESPONSE_BYTES,
  });
  if (
    !isRecord(body) ||
    !isRecord(body.data) ||
    !Array.isArray(body.data.endpoints)
  ) {
    throw validationError("AI provider returned an invalid endpoint list");
  }

  const providers: OpenRouterUpstreamProvider[] = [];
  const seen = new Set<string>();
  for (const endpoint of body.data.endpoints as unknown[]) {
    if (!isRecord(endpoint) || typeof endpoint.tag !== "string") continue;
    const slug = endpoint.tag.trim();
    if (
      slug.length > 120 ||
      !PROVIDER_SLUG_PATTERN.test(slug) ||
      seen.has(slug)
    ) {
      continue;
    }
    const rawLabel =
      typeof endpoint.name === "string" && endpoint.name.trim()
        ? endpoint.name.trim()
        : typeof endpoint.provider_name === "string" &&
            endpoint.provider_name.trim()
          ? endpoint.provider_name.trim()
          : slug;
    const label = rawLabel.slice(0, 160);
    seen.add(slug);
    providers.push({ label, slug });
    if (providers.length >= MAX_UPSTREAM_PROVIDERS) break;
  }
  return providers;
}
