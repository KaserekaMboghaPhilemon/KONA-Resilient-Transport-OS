import express from "express";
import auditRouter from "./routes/audit";
import smsIntakeRouter from "./routes/smsIntake";
import syncRouter from "./routes/sync";

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api/v1/audit", auditRouter);
app.use("/api/v1/sms", smsIntakeRouter);
app.use("/api/v1/sync", syncRouter);

app.listen(port, "127.0.0.1", () => {
  console.log(`KONA development server listening on http://127.0.0.1:${port}`);
});
