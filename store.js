import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PRODUCTS_FILE = path.join(__dirname, "data", "products.json");
const CHANNELS_FILE = path.join(__dirname, "data", "channels.json");
const SCHEDULES_FILE = path.join(__dirname, "data", "schedules.json");

const log = (message, meta) => {
  if (meta === undefined) {
    console.log(`[store] ${message}`);
    return;
  }
  console.log(`[store] ${message}`, meta);
};

async function readJsonArray(filePath, label) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const data = Array.isArray(parsed) ? parsed : [];
    log(`${label} loaded`, { count: data.length });
    return data;
  } catch {
    log(`${label} file missing or invalid, returning empty list`);
    return [];
  }
}

async function writeJsonArray(filePath, label, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
  log(`${label} saved`, { count: value.length });
}

export async function getProducts() {
  return readJsonArray(PRODUCTS_FILE, "products");
}

export async function saveProducts(products) {
  await writeJsonArray(PRODUCTS_FILE, "products", products);
}

export async function addProduct(product) {
  const products = await getProducts();
  const next = [product, ...products];
  await saveProducts(next);
  log("product added", { id: product.id, name: product.name });
  return product;
}

export async function deleteProduct(id) {
  const products = await getProducts();
  const next = products.filter((p) => p.id !== id);
  await saveProducts(next);
  log("product delete requested", { id, removed: next.length !== products.length });
  return next.length !== products.length;
}

export async function updateProduct(id, patch) {
  const products = await getProducts();
  const index = products.findIndex((p) => p.id === id);
  if (index < 0) {
    log("product update requested but not found", { id });
    return null;
  }

  const updated = {
    ...products[index],
    ...patch,
    id: products[index].id,
    updatedAt: new Date().toISOString()
  };
  products[index] = updated;
  await saveProducts(products);
  log("product updated", { id, name: updated.name });
  return updated;
}

export async function getChannels() {
  return readJsonArray(CHANNELS_FILE, "channels");
}

export async function saveChannels(channels) {
  await writeJsonArray(CHANNELS_FILE, "channels", channels);
}

export async function addChannel(channel) {
  const channels = await getChannels();
  const next = [channel, ...channels.filter((c) => c.channelIdNormalized !== channel.channelIdNormalized)];
  await saveChannels(next);
  log("channel added", { id: channel.id, name: channel.name, channelIdNormalized: channel.channelIdNormalized });
  return channel;
}

export async function deleteChannel(id) {
  const channels = await getChannels();
  const next = channels.filter((c) => c.id !== id);
  await saveChannels(next);
  log("channel delete requested", { id, removed: next.length !== channels.length });
  return next.length !== channels.length;
}

export async function getSchedules() {
  return readJsonArray(SCHEDULES_FILE, "schedules");
}

export async function saveSchedules(schedules) {
  await writeJsonArray(SCHEDULES_FILE, "schedules", schedules);
}

export async function addSchedule(schedule) {
  const schedules = await getSchedules();
  const next = [schedule, ...schedules];
  await saveSchedules(next);
  log("schedule added", { id: schedule.id, channelId: schedule.channelId, sendAt: schedule.sendAt });
  return schedule;
}

export async function updateSchedule(id, patch) {
  const schedules = await getSchedules();
  const index = schedules.findIndex((s) => s.id === id);
  if (index < 0) {
    log("schedule update requested but not found", { id });
    return null;
  }
  const updated = { ...schedules[index], ...patch, id: schedules[index].id };
  schedules[index] = updated;
  await saveSchedules(schedules);
  log("schedule updated", { id, status: updated.status });
  return updated;
}

export async function deleteSchedule(id) {
  const schedules = await getSchedules();
  const next = schedules.filter((s) => s.id !== id);
  await saveSchedules(next);
  log("schedule delete requested", { id, removed: next.length !== schedules.length });
  return next.length !== schedules.length;
}
