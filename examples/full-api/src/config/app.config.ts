/**
 * Application Configuration
 */

import type { NuraljsConfig } from "@nuraljs/core";
import { errorHandler } from "./error-handler";

export const appConfig: NuraljsConfig = {
  framework: "fastify",

  // CORS configuration
  cors: {
    origin: [
      "http://localhost:3000",
      "http://localhost:5173",
      "https://myapp.com",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id"],
  },

  // Security headers
  helmet: {
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
    contentSecurityPolicy: false, // Disable for API
    frameguard: { action: "deny" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  },

  // Custom error handler
  errorHandler,

  // API documentation
  docs: {
    enabled: true,
    path: "/docs",
    ui: "scalar", // Try "swagger" to see Swagger UI

    // OpenAPI Customization
    openApi: {
      info: {
        title: "Full-Featured API",
        version: "1.0.0",
        description:
          "Production-grade REST API with authentication, CRUD, and validation",
        contact: {
          name: "API Support",
          email: "support@example.com",
        },
      },
      servers: [{ url: "http://localhost:3000", description: "Local Server" }],
      // Security Definitions
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
        },
      },
      // Apply security globally
      security: [{ bearerAuth: [] }],
    },

    // Scalar UI Options
    scalar: {
      theme: "deepSpace", // Try 'moon', 'purple', 'solarized', etc.
      layout: "modern",
      showSidebar: true,
      hideModels: true,
      hideDownloadButton: false,
      hideClientButton: false,
      darkMode: true,
      // Custom Metadata
      metaData: {
        title: "Nuraljs API Documentation",
      },
      // Authentication
      authentication: {
        preferredSecurityScheme: "bearerAuth",
        securitySchemes: {
          bearerAuth: {
            token: "EXAMPLE_TOKEN",
          },
        },
      },
    },

    // Swagger UI Options
    // swagger: {
    //   theme: "classic", // 'outline', 'classic', or 'no-theme'
    //   options: {
    //     persistAuthorization: true,
    //     filter: true,
    //     displayRequestDuration: true,
    //     docExpansion: "list",
    //     defaultModelsExpandDepth: -1, // Hide models by default
    //   },
    // },
  },

  // Logger configuration
  logger: {
    enabled: true,
    showUserAgent: true,
    showTime: true,
  },
};
