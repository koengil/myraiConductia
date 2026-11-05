declare module 'swagger-ui-dist' {
  interface SwaggerRequest {
    url?: string;
    method?: string;
    credentials?: RequestCredentials;
    headers?: Record<string, string>;
    [key: string]: unknown;
  }

  interface SwaggerUIOptions {
    url?: string;
    spec?: object;
    domNode?: HTMLElement | null;
    dom_id?: string;
    docExpansion?: 'list' | 'full' | 'none';
    deepLinking?: boolean;
    presets?: unknown[];
    plugins?: unknown[];
    layout?: string;
    requestInterceptor?: (request: SwaggerRequest) => SwaggerRequest | Promise<SwaggerRequest>;
    responseInterceptor?: (response: unknown) => unknown;
    [key: string]: unknown;
  }

  interface SwaggerUIBundleConstructor {
    (options: SwaggerUIOptions): unknown;
    presets: { apis: unknown };
  }

  export const SwaggerUIBundle: SwaggerUIBundleConstructor;
  export const SwaggerUIStandalonePreset: unknown;
  export function absolutePath(): string;
  export function getAbsoluteFSPath(): string;
}

declare module 'swagger-ui-dist/swagger-ui.css';
