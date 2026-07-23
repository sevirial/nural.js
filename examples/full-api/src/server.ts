/**
 * Full-Featured API Server
 *
 * Production-grade REST API demonstrating all Nuraljs features:
 * - Authentication & Authorization
 * - CRUD Operations
 * - Input Validation (Zod)
 * - Custom Error Handling
 * - CORS & Helmet Security
 * - Auto-generated Documentation
 *
 * Run: npx tsx examples/full-api/src/server.ts
 *
 * Structure:
 * ├── config/        - App configuration
 * ├── middleware/    - Auth & other middleware
 * ├── routes/        - API route definitions
 * ├── schemas/       - Zod validation schemas
 * ├── services/      - Business logic
 * └── server.ts      - Entry point
 */

import { Nuraljs } from "@nuraljs/core";
import { appConfig } from "./config";
import { authRoutes, userRoutes, healthRoutes } from "./routes";
import { Server } from "socket.io";

// Create application
const app = new Nuraljs(appConfig);

// Register routes
app.register([...healthRoutes, ...authRoutes, ...userRoutes]);

// Start server
const PORT = Number(process.env.PORT) || 3000;
const server = app.start(PORT);

const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for dev
    methods: ["GET", "POST"],
  },
});

// 4. Handle Sockets
io.on("connection", (socket) => {
  console.log(`⚡ Client connected: ${socket.id}`);

  socket.on("disconnect", () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});

// Custom logger usage
import { Logger } from "@nuraljs/core";
const logger = new Logger("Example");

logger.log(`Server started at http://localhost:${PORT}`);
logger.log(`Docs available at http://localhost:${PORT}/docs`);
