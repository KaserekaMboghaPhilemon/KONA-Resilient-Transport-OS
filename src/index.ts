import express from "express";
import auditRouter from "./routes/audit";
import smsIntakeRouter from "./routes/smsIntake";
import syncRouter from "./routes/sync";
import telemetryRouter from "./routes/telemetry";

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api/v1/audit", auditRouter);
app.use("/api/v1/sms", smsIntakeRouter);
app.use("/api/v1/sync", syncRouter);
app.use("/api/v1/telemetry", telemetryRouter);

app.get("/", (_req, res) => {
  res.json({ status: "success", message: "KONA Transport OS API is running" });
});

const host = process.env.HOST ?? "0.0.0.0";

app.listen(port, host, () => {
  console.log(`KONA server listening on http://${host}:${port}`);
});
