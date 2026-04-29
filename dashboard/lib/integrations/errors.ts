export class IntegrationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly provider?: string
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

export class TokenRefreshError extends IntegrationError {
  constructor(message: string, provider?: string) {
    super(message, "token_refresh_failed", provider);
    this.name = "TokenRefreshError";
  }
}

export class ScopeMismatchError extends IntegrationError {
  constructor(
    message: string,
    public readonly required: string[],
    public readonly granted: string[],
    provider?: string
  ) {
    super(message, "scope_mismatch", provider);
    this.name = "ScopeMismatchError";
  }
}

export class ProviderApiError extends IntegrationError {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly providerResponse?: unknown,
    provider?: string
  ) {
    super(message, "provider_api_error", provider);
    this.name = "ProviderApiError";
  }
}

export class NotConnectedError extends IntegrationError {
  constructor(provider?: string) {
    super("Integration is not connected", "not_connected", provider);
    this.name = "NotConnectedError";
  }
}
