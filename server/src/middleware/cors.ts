import cors from "cors";

function isLocalDevOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

export const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    // Same-origin / non-browser clients omit Origin.
    if (!origin || isLocalDevOrigin(origin)) {
      callback(null, origin ?? true);
      return;
    }
    callback(new Error(`CORS origin not allowed: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Version"],
  credentials: true,
  maxAge: 86400,
};

export const corsMiddleware = cors(corsOptions);