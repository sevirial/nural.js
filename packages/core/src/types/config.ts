/**
 * Configuration Types
 * Types for Nuraljs framework configuration
 */

/**
 * Documentation configuration options
 */

/**
 * Scalar UI Configuration
 * @see https://github.com/scalar/scalar
 */
export interface ScalarConfig {
  theme?:
    | "alternate"
    | "default"
    | "moon"
    | "purple"
    | "solarized"
    | "bluePlanet"
    | "saturn"
    | "kepler"
    | "mars"
    | "deepSpace"
    | "laserwave"
    | "none";
  layout?: "modern" | "classic";
  scale?: number;
  content?: string | Record<string, any>;
  spec?: { url?: string; content?: string | Record<string, any> };
  proxyUrl?: string;
  isEditable?: boolean;
  showSidebar?: boolean;
  hideModels?: boolean;
  hideDownloadButton?: boolean;
  hideTestRequestButton?: boolean;
  hideSearch?: boolean;
  darkMode?: boolean;
  forceDarkModeState?: "dark" | "light";
  hideDarkModeToggle?: boolean;
  customCss?: string;
  searchHotKey?: string;
  metaData?: Record<string, any>;
  hiddenClients?: string[] | boolean | Record<string, any>;
  
  // Auth
  authentication?: {
    preferredSecurityScheme?: string | string[];
    securitySchemes?: Record<string, any>;
    
    // Allow HTTP auth defaults (Bearer, Basic)
    http?: {
      bearer?: { token?: string };
      basic?: { username?: string; password?: string };
      [key: string]: any;
    };
    
    // Allow ApiKey defaults
    apiKey?: {
      token?: string;
      [key: string]: any;
    };

    // Allow other auth types (OAuth2, etc.)
    [key: string]: any; 
  };

  // Advanced
  defaultHttpClient?: { targetKey: string; clientKey: string };
  withDefaultFonts?: boolean;
  defaultOpenAllTags?: boolean;
  tagsSorter?: "alpha" | Function;
  operationsSorter?: "alpha" | "method" | Function;
  [key: string]: any;
}

/**
 * Swagger UI Configuration
 * @see https://github.com/swagger-api/swagger-ui/blob/master/docs/usage/configuration.md
 */
export interface SwaggerConfig {
  /**
   * Swagger UI Theme
   * - outline: A modern, clean theme (default)
   * - classic: The standard Swagger UI look
   * - no-theme: No extra styling included (use your own)
   */
  theme?: "outline" | "classic" | "no-theme";
  options?: {
    dom_id?: string;
    domNode?: any;
    spec?: any;
    url?: string;
    urls?: { url: string; name: string }[];
    layout?: string;
    docExpansion?: "list" | "full" | "none";
    maxDisplayedTags?: number;
    depth?: number;
    filter?: boolean | string;
    deepLinking?: boolean;
    displayOperationId?: boolean;
    defaultModelsExpandDepth?: number;
    defaultModelExpandDepth?: number;
    defaultModelRendering?: "example" | "model";
    displayRequestDuration?: boolean;
    showExtensions?: boolean;
    showCommonExtensions?: boolean;
    showMutatedRequest?: boolean;
    supportedSubmitMethods?: string[];
    validatorUrl?: string | null;
    withCredentials?: boolean;
    persistAuthorization?: boolean;
    oauth2RedirectUrl?: string;
    plugins?: any[];
    presets?: any[];
    [key: string]: any;
  };
}

/**
 * Documentation configuration options
 */
export interface DocsConfig {
  /** Enable documentation endpoint */
  enabled?: boolean;
  /**
   * Documentation UI path (default: /docs)
   */
  path?: string;
  /**
   * Documentation UI type
   * @default "scalar"
   */
  ui?: "scalar" | "swagger";
  /**
   * OpenAPI Specification overrides
   * Allows full customization of the OpenAPI document
   */
  openApi?: {
    info?: {
      title?: string;
      version?: string;
      description?: string;
      termsOfService?: string;
      contact?: { name?: string; url?: string; email?: string };
      license?: { name?: string; url?: string };
    };
    servers?: Array<{ url: string; description?: string }>;
    components?: {
      securitySchemes?: Record<string, any>;
      [key: string]: any;
    };
    security?: Array<Record<string, string[]>>;
    tags?: Array<{ name: string; description?: string }>;
    externalDocs?: { description?: string; url: string };
  };
  /** Configuration specific to Scalar UI */
  scalar?: ScalarConfig;
  /** Configuration specific to Swagger UI */
  swagger?: SwaggerConfig;
  // Backward compatibility
  title?: string;
  version?: string;
  description?: string;
}

/**
 * Main Nuraljs framework configuration
 */
export interface NuraljsConfig {
  /** Server framework to use */
  framework?: "express" | "fastify";
  /** Documentation settings (true for defaults, false to disable, or DocsConfig) */
  docs?: boolean | DocsConfig;
  /** CORS settings (true for defaults, false to disable, or CorsConfig) */
  cors?: boolean | import("./middleware").CorsConfig;
  /** Helmet security headers (true for defaults, false to disable, or HelmetConfig) */
  helmet?: boolean | import("./middleware").HelmetConfig;
  /** Logger configuration */
  logger?: {
    enabled?: boolean;
    showUserAgent?: boolean;
    showTime?: boolean;
  };
  /** Global error handler (true for defaults, function, or config) */
  errorHandler?:
    | boolean
    | import("./error").ErrorHandler
    | import("./error").ErrorHandlerConfig;
}

/**
 * Resolved documentation configuration (with defaults applied)
 */
export interface ResolvedDocsConfig {
  enabled: boolean;
  path: string;
  ui: "scalar" | "swagger";
  openApi: NonNullable<DocsConfig["openApi"]>;
  scalar: ScalarConfig;
  swagger: SwaggerConfig;
}

/**
 * Default documentation configuration
 */
export const DEFAULT_DOCS_CONFIG: ResolvedDocsConfig = {
  enabled: true,
  path: "/docs",
  ui: "scalar",
  openApi: {
    info: {
      title: "Nuraljs API",
      version: "1.0.0",
      description: "Powered by Nuraljs Framework",
    },
    servers: [{ url: "/" }],
  },
  scalar: {},
  swagger: {},
};

/**
 * Resolve docs config from user input
 */
export function resolveDocsConfig(
  docs?: boolean | DocsConfig,
): ResolvedDocsConfig {
  if (docs === false) {
    return { ...DEFAULT_DOCS_CONFIG, enabled: false };
  }

  if (docs === true || docs === undefined) {
    return DEFAULT_DOCS_CONFIG;
  }

  // Merge with defaults
  return {
    enabled: docs.enabled ?? true,
    path: docs.path ?? DEFAULT_DOCS_CONFIG.path,
    ui: docs.ui ?? DEFAULT_DOCS_CONFIG.ui,
    openApi: {
      ...DEFAULT_DOCS_CONFIG.openApi,
      ...docs.openApi,
      info: {
        ...DEFAULT_DOCS_CONFIG.openApi.info,
        ...docs.openApi?.info,
        // Backward compatibility: use top-level fields if provided
        title:
          docs.title ??
          docs.openApi?.info?.title ??
          DEFAULT_DOCS_CONFIG.openApi.info?.title,
        version:
          docs.version ??
          docs.openApi?.info?.version ??
          DEFAULT_DOCS_CONFIG.openApi.info?.version,
        description:
          docs.description ??
          docs.openApi?.info?.description ??
          DEFAULT_DOCS_CONFIG.openApi.info?.description,
      },
    },
    scalar: docs.scalar ?? {},
    swagger: docs.swagger ?? {},
  };
}
