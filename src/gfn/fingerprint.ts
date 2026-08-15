import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface DeviceFingerprint {
  clientId: string;
  deviceId: string;
  deviceMake: string;
  deviceModel: string;
  browserType: "CHROME" | "EDGE";
  userAgent: string;
  createdAt: number;
}

const DEVICE_POOL = [
  { make: "ASUS", models: ["ROG STRIX G15", "TUF GAMING F15", "ROG ZEPHYRUS G14", "ROG ALLY"] },
  { make: "LENOVO", models: ["LEGION 5", "LEGION PRO 7", "IDEAPAD GAMING 3", "THINKPAD X1"] },
  { make: "MSI", models: ["KATANA GF66", "STEALTH 15M", "RAIDER GE76", "CYBORG 15"] },
  { make: "DELL", models: ["ALIENWARE M15", "G15 5520", "INSPIRON 16", "XPS 15"] },
  { make: "HP", models: ["OMEN 16", "VICTUS 15", "PAVILION GAMING", "ENVY 17"] },
  { make: "ACER", models: ["NITRO 5", "PREDATOR HELIOS 300", "ASPIRE 7", "SWIFT X"] },
];

const CHROME_UA_TEMPLATE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version}.0.0.0 Safari/537.36 NVIDIACEFClient/HEAD/debb5919f6 GFN-PC/2.0.80.173";

const EDGE_UA_TEMPLATE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version}.0.0.0 Safari/537.36 Edg/{version}.0.0.0 NVIDIACEFClient/HEAD/debb5919f6 GFN-PC/2.0.80.173";

const CHROME_VERSIONS = ["125", "126", "127", "128", "129"];

export class FingerprintManager {
  private filePath: string;
  private fingerprints: Record<string, DeviceFingerprint> = {};

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "fingerprints.json");
  }

  async load(): Promise<void> {
    try {
      if (existsSync(this.filePath)) {
        const raw = await readFile(this.filePath, "utf8");
        this.fingerprints = JSON.parse(raw) as Record<string, DeviceFingerprint>;
      }
    } catch (error) {
      console.warn("[FingerprintManager] failed to load fingerprints:", error);
      this.fingerprints = {};
    }
  }

  async save(): Promise<void> {
    try {
      await writeFile(this.filePath, JSON.stringify(this.fingerprints, null, 2), "utf8");
    } catch (error) {
      console.error("[FingerprintManager] failed to save fingerprints:", error);
    }
  }

  getOrCreate(userId: string): DeviceFingerprint {
    const existing = this.fingerprints[userId];
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000; // 7 days

    if (existing && Date.now() - existing.createdAt < maxAgeMs) {
      return existing;
    }

    // Generate a new fingerprint — guaranteed non-undefined via fallback
    const poolIdx = Math.floor(Math.random() * DEVICE_POOL.length) % DEVICE_POOL.length;
    const brand = DEVICE_POOL[poolIdx] ?? DEVICE_POOL[0]!;
    const modelIdx = Math.floor(Math.random() * brand.models.length) % brand.models.length;
    const model = brand.models[modelIdx] ?? brand.models[0] ?? "UNKNOWN";

    const browserType: "CHROME" | "EDGE" = Math.random() > 0.5 ? "CHROME" : "EDGE";
    const verIdx = Math.floor(Math.random() * CHROME_VERSIONS.length) % CHROME_VERSIONS.length;
    const ver = CHROME_VERSIONS[verIdx] ?? "128";
    const template = browserType === "CHROME" ? CHROME_UA_TEMPLATE : EDGE_UA_TEMPLATE;
    const userAgent = template.replace(/\{version\}/g, ver);

    const fingerprint: DeviceFingerprint = {
      clientId: randomUUID(),
      deviceId: randomUUID().replace(/-/g, ""), // device ID is often hex without dashes
      deviceMake: brand.make,
      deviceModel: model,
      browserType,
      userAgent,
      createdAt: Date.now(),
    };

    this.fingerprints[userId] = fingerprint;
    void this.save(); // save asynchronously in background

    console.log(`[FingerprintManager] Generated fingerprint for ${userId} — ${brand.make} ${model} (${browserType})`);
    return fingerprint;
  }
}
