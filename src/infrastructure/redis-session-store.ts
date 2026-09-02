import type { Redis } from "ioredis";
import { z } from "zod";
import type { SessionData } from "../core/types.js";
import type { SessionStore } from "../ports.js";

const sessionSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  userId: z.number().int().positive(),
  csrfToken: z.string().regex(/^[a-f0-9]{64}$/),
  uploadScope: z.string().regex(/^[a-f0-9]{64}$/),
  authEpoch: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  rememberSelector: z.string().regex(/^[a-f0-9]{24}$/).nullable(),
});

export class RedisSessionStore implements SessionStore {
  public constructor(
    private readonly redis: Redis,
    private readonly keyPrefix: string,
  ) {}

  public async get(sessionId: string): Promise<SessionData | null> {
    await this.#connect();
    const raw = await this.redis.get(this.#key(sessionId));
    if (raw === null) {
      return null;
    }
    try {
      const parsed = sessionSchema.safeParse(JSON.parse(raw) as unknown);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  public async set(session: SessionData, ttlSeconds: number): Promise<void> {
    await this.#connect();
    await this.redis.set(this.#key(session.id), JSON.stringify(session), "EX", ttlSeconds);
  }

  public async delete(sessionId: string): Promise<void> {
    await this.#connect();
    await this.redis.del(this.#key(sessionId));
  }

  async #connect(): Promise<void> {
    if (this.redis.status === "wait") {
      await this.redis.connect();
    }
  }

  #key(sessionId: string): string {
    return `${this.keyPrefix}:session:${sessionId}`;
  }
}
