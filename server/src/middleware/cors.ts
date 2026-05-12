import cors from "cors";

export const corsOptions: cors.CorsOptions = {
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Version"],
  credentials: true,
  maxAge: 86400,
};

export const corsMiddleware = cors(corsOptions);