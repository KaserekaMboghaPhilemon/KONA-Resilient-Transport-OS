import express from "express";
import auditRouter from "./routes/audit";
import healthRouter from "./routes/health";
import smsIntakeRouter from "./routes/smsIntake";
import syncRouter from "./routes/sync";
import telemetryRouter from "./routes/telemetry";

export function createApp(): express.Express {
  const app = express();

  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: true, limit: '16kb', parameterLimit: 20 }));
  app.use(healthRouter);
  app.use("/api/v1/audit", auditRouter);
  app.use("/api/v1/sms", smsIntakeRouter);
  app.use("/api/v1/sync", syncRouter);
  app.use("/api/v1/telemetry", telemetryRouter);

  app.get("/", (_req, res) => {
    res.json({ status: "success", message: "KONA Transport OS API is running" });
  });

  return app;
}

export const app = createApp();

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";

  app.listen(port, host, () => {
    console.log(`KONA server listening on http://${host}:${port}`);
  });
}
