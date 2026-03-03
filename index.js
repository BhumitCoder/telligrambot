import crypto from "node:crypto";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import {
  addChannel,
  addProduct,
  addSchedule,
  addSubscribersBulk,
  deleteChannel,
  deleteProduct,
  deleteSchedule,
  getChannels,
  getProducts,
  getSubscribers,
  getSchedules,
  updateProduct,
  updateSchedule
} from "./store.js";
import { sendProductsBulk, verifyChannel, verifyTelegramSetup } from "./telegram.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 4000);
const scheduleTimers = new Map();

const log = (message, meta) => {
  if (meta === undefined) {
    console.log(`[api] ${message}`);
    return;
  }
  console.log(`[api] ${message}`, meta);
};

function normalizePhoneNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const startsWithPlus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return startsWithPlus ? `+${digits}` : digits;
}

function parseBulkNumbers(input) {
  const text = String(input || "");
  const parts = text.split(/[\s,;\n\r\t]+/).map((item) => normalizePhoneNumber(item)).filter(Boolean);
  const unique = [...new Set(parts)];
  const valid = unique.filter((num) => /^\+?\d{7,15}$/.test(num));
  const invalid = unique.filter((num) => !/^\+?\d{7,15}$/.test(num));
  return { valid, invalid };
}

function clearScheduleTimer(scheduleId) {
  const timer = scheduleTimers.get(scheduleId);
  if (timer) {
    clearTimeout(timer);
    scheduleTimers.delete(scheduleId);
  }
}

async function executeSchedule(scheduleId) {
  clearScheduleTimer(scheduleId);
  const schedules = await getSchedules();
  const schedule = schedules.find((s) => s.id === scheduleId);
  if (!schedule || schedule.status !== "pending") {
    return;
  }

  log("executing schedule", { scheduleId, channelId: schedule.channelId, productCount: schedule.productIds.length });
  const allProducts = await getProducts();
  const selected = allProducts.filter((p) => schedule.productIds.includes(p.id));
  if (selected.length === 0) {
    await updateSchedule(scheduleId, {
      status: "failed",
      error: "No matching products found at execution time",
      finishedAt: new Date().toISOString()
    });
    return;
  }

  const results = await sendProductsBulk(selected, { channelId: schedule.channelId });
  const sent = results.filter((x) => x.ok).length;
  const failed = results.filter((x) => !x.ok).length;

  await updateSchedule(scheduleId, {
    status: failed > 0 ? "completed_with_errors" : "completed",
    sent,
    failed,
    results,
    finishedAt: new Date().toISOString()
  });
}

function queueSchedule(schedule) {
  if (!schedule || schedule.status !== "pending") return;
  clearScheduleTimer(schedule.id);

  const sendAtMs = new Date(schedule.sendAt).getTime();
  const delay = Number.isFinite(sendAtMs) ? Math.max(0, sendAtMs - Date.now()) : 0;
  const timer = setTimeout(() => {
    executeSchedule(schedule.id).catch((error) => {
      log("scheduled execution failed", { scheduleId: schedule.id, error: error instanceof Error ? error.message : String(error) });
    });
  }, delay);
  scheduleTimers.set(schedule.id, timer);
  log("schedule queued", { scheduleId: schedule.id, delayMs: delay });
}

async function rehydrateSchedules() {
  const schedules = await getSchedules();
  for (const schedule of schedules) {
    if (schedule.status === "pending") {
      queueSchedule(schedule);
    }
  }
}

app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use((req, res, next) => {
  const startedAt = Date.now();
  log("request started", { method: req.method, path: req.path });
  res.on("finish", () => {
    log("request completed", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "telegram-product-server" });
});

app.get("/api/telegram/check", async (req, res) => {
  try {
    const channelId = String(req.query.channelId || "");
    const data = channelId ? await verifyChannel(channelId) : await verifyTelegramSetup();
    return res.json(data);
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      hint: "Use valid channel ID (@username or -100...) and add bot as admin with posting permission."
    });
  }
});

app.get("/api/channels", async (_req, res) => {
  const channels = await getChannels();
  res.json({ ok: true, channels });
});

app.post("/api/channels", async (req, res) => {
  const { channelId } = req.body ?? {};
  if (!channelId || typeof channelId !== "string") {
    return res.status(400).json({ ok: false, error: "channelId is required" });
  }

  try {
    const verified = await verifyChannel(channelId);
    const channel = {
      id: crypto.randomUUID(),
      name: String(verified.chatTitle || verified.channelIdNormalized).trim(),
      channelIdRaw: channelId.trim(),
      channelIdNormalized: verified.channelIdNormalized,
      chatTitle: verified.chatTitle || "",
      chatType: verified.chatType || "",
      createdAt: new Date().toISOString()
    };
    await addChannel(channel);
    return res.status(201).json({ ok: true, channel });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.delete("/api/channels/:id", async (req, res) => {
  const removed = await deleteChannel(req.params.id);
  if (!removed) {
    return res.status(404).json({ ok: false, error: "channel not found" });
  }
  return res.json({ ok: true });
});

app.get("/api/subscribers", async (req, res) => {
  const channelId = String(req.query.channelId || "").trim();
  const subscribers = await getSubscribers();
  const list = channelId ? subscribers.filter((x) => x.channelIdNormalized === channelId) : subscribers;
  return res.json({ ok: true, subscribers: list });
});

app.post("/api/subscribers/bulk", async (req, res) => {
  const { channelId, numbers, rawNumbers } = req.body ?? {};
  if (!channelId || typeof channelId !== "string") {
    return res.status(400).json({ ok: false, error: "channelId is required" });
  }

  const payload =
    Array.isArray(numbers) ? numbers.join("\n") : typeof rawNumbers === "string" ? rawNumbers : String(numbers || "");
  const { valid, invalid } = parseBulkNumbers(payload);
  if (valid.length === 0) {
    return res.status(400).json({ ok: false, error: "No valid phone numbers found", invalid });
  }

  const channels = await getChannels();
  const exists = channels.some((c) => c.channelIdNormalized === channelId);
  if (!exists) {
    return res.status(404).json({ ok: false, error: "Selected channel not found" });
  }

  const result = await addSubscribersBulk(channelId, valid);
  return res.status(201).json({
    ok: true,
    channelId,
    ...result,
    invalid,
    note:
      "Numbers are stored for this channel. Telegram bot API cannot directly subscribe phone numbers to channels."
  });
});

app.get("/api/products", async (_req, res) => {
  const products = await getProducts();
  res.json({ ok: true, products });
});

app.post("/api/products", async (req, res) => {
  const { name, price, details, imageUrl, imageBase64, imageMime, imageFileName } = req.body ?? {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ ok: false, error: "name is required" });
  }

  const product = {
    id: crypto.randomUUID(),
    name: name.trim(),
    price: String(price ?? "").trim(),
    details: String(details ?? "").trim(),
    imageUrl: String(imageUrl ?? "").trim(),
    imageBase64: String(imageBase64 ?? "").trim(),
    imageMime: String(imageMime ?? "").trim(),
    imageFileName: String(imageFileName ?? "").trim(),
    createdAt: new Date().toISOString()
  };
  await addProduct(product);
  return res.status(201).json({ ok: true, product });
});

app.put("/api/products/:id", async (req, res) => {
  const { name, price, details, imageUrl, imageBase64, imageMime, imageFileName } = req.body ?? {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ ok: false, error: "name is required" });
  }

  const updated = await updateProduct(req.params.id, {
    name: name.trim(),
    price: String(price ?? "").trim(),
    details: String(details ?? "").trim(),
    imageUrl: String(imageUrl ?? "").trim(),
    imageBase64: String(imageBase64 ?? "").trim(),
    imageMime: String(imageMime ?? "").trim(),
    imageFileName: String(imageFileName ?? "").trim()
  });

  if (!updated) {
    return res.status(404).json({ ok: false, error: "product not found" });
  }

  return res.json({ ok: true, product: updated });
});

app.delete("/api/products/:id", async (req, res) => {
  const removed = await deleteProduct(req.params.id);
  if (!removed) {
    return res.status(404).json({ ok: false, error: "product not found" });
  }
  return res.json({ ok: true });
});

app.post("/api/send", async (req, res) => {
  const { productIds, channelIds, channelId } = req.body ?? {};
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return res.status(400).json({ ok: false, error: "productIds must be a non-empty array" });
  }

  const all = await getProducts();
  const selected = all.filter((p) => productIds.includes(p.id));
  if (selected.length === 0) {
    return res.status(404).json({ ok: false, error: "No matching products found" });
  }

  const normalizedChannels = Array.isArray(channelIds)
    ? channelIds.map((c) => String(c || "").trim()).filter(Boolean)
    : String(channelId || "").trim()
      ? [String(channelId || "").trim()]
      : [];

  if (normalizedChannels.length === 0) {
    return res.status(400).json({ ok: false, error: "Select at least one channel" });
  }

  log("multi-channel send requested", {
    productCount: selected.length,
    channelCount: [...new Set(normalizedChannels)].length,
    channels: [...new Set(normalizedChannels)]
  });

  const perChannel = [];
  const flatResults = [];
  for (const cid of [...new Set(normalizedChannels)]) {
    const results = await sendProductsBulk(selected, { channelId: cid });
    const sent = results.filter((x) => x.ok).length;
    const failed = results.filter((x) => !x.ok).length;
    perChannel.push({ channelId: cid, sent, failed, results });
    for (const row of results) {
      flatResults.push({ ...row, channelId: cid });
    }
  }

  const sent = flatResults.filter((x) => x.ok).length;
  const failed = flatResults.filter((x) => !x.ok).length;
  return res.json({
    ok: true,
    sent,
    failed,
    channels: perChannel,
    results: flatResults
  });
});

app.get("/api/schedules", async (_req, res) => {
  const schedules = await getSchedules();
  res.json({ ok: true, schedules });
});

app.post("/api/schedules", async (req, res) => {
  const { channelId, productIds, sendAt } = req.body ?? {};
  if (!channelId || typeof channelId !== "string") {
    return res.status(400).json({ ok: false, error: "channelId is required" });
  }
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return res.status(400).json({ ok: false, error: "productIds must be a non-empty array" });
  }

  const when = new Date(sendAt);
  if (!sendAt || Number.isNaN(when.getTime())) {
    return res.status(400).json({ ok: false, error: "sendAt must be a valid datetime" });
  }

  try {
    const verified = await verifyChannel(channelId);
    const schedule = {
      id: crypto.randomUUID(),
      channelId: verified.channelIdNormalized,
      channelName: verified.chatTitle || verified.channelIdNormalized,
      productIds: [...new Set(productIds)],
      sendAt: when.toISOString(),
      status: "pending",
      createdAt: new Date().toISOString(),
      sent: 0,
      failed: 0,
      results: []
    };
    await addSchedule(schedule);
    queueSchedule(schedule);
    return res.status(201).json({ ok: true, schedule });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.delete("/api/schedules/:id", async (req, res) => {
  clearScheduleTimer(req.params.id);
  const removed = await deleteSchedule(req.params.id);
  if (!removed) {
    return res.status(404).json({ ok: false, error: "schedule not found" });
  }
  return res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  rehydrateSchedules().catch((error) => {
    log("schedule rehydrate failed", { error: error instanceof Error ? error.message : String(error) });
  });
});
