import { googleCalendarProvider } from "./google-calendar";
import { IntegrationProvider } from "./provider";

const registry = new Map<string, IntegrationProvider>([
  [googleCalendarProvider.slug, googleCalendarProvider],
]);

export function getProvider(slug: string): IntegrationProvider | undefined {
  return registry.get(slug);
}

export function listProviders(): IntegrationProvider[] {
  return Array.from(registry.values());
}
