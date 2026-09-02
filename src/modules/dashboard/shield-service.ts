const filteredHistoryDays = 7;
const unsignedCounterMax = 18_446_744_073_709_551_615n;
const indiaTimeZone = "Asia/Kolkata";
const indiaOffset = "+05:30";
const weekDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export interface TrafficShieldDateSlot {
  readonly slot: number;
  readonly date: string;
}

export interface TrafficShieldAggregate {
  /** Strict UTC `Y-m-d H:i:s`, null when the marker is missing or malformed. */
  readonly activationStartedAtUtc: string | null;
  readonly lifetimeTotal: bigint;
  /** One counter for every requested date slot, in request order. */
  readonly dailyTotals: readonly bigint[];
}

export interface TrafficShieldStore {
  loadTrafficShieldAggregate(
    userId: number,
    slots: readonly TrafficShieldDateSlot[],
  ): Promise<TrafficShieldAggregate>;
}

export interface TrafficShieldDay {
  readonly label: string;
  readonly iso: string;
  readonly count: string | null;
  readonly state: "collecting" | "exact" | "exact_so_far";
}

export interface TrafficShieldReport {
  readonly ok: true;
  /** Current-link filtered lifetime total, including retained migrated history. */
  readonly total: string;
  readonly history_total: string | null;
  readonly history_state: "collecting" | "exact";
  readonly history_started_at: string | null;
  readonly days: readonly TrafficShieldDay[];
}

/**
 * Load the PHP-compatible compact Shield report for every current link owned by
 * one author. The store performs the single bounded aggregate query; this
 * service owns all India-day, slot and activation-completeness semantics.
 */
export async function loadTrafficShieldReport(
  store: TrafficShieldStore,
  userId: number,
  now = new Date(),
): Promise<TrafficShieldReport> {
  if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(now.getTime())) {
    throw new RangeError("Traffic Shield requires a valid user and timestamp.");
  }

  const today = indiaBusinessDate(now);
  const requestedDays = Array.from({ length: filteredHistoryDays }, (_, index) => {
    const iso = shiftIsoDate(today, -index);
    return {
      iso,
      slot: trafficShieldSlotForDate(iso),
      dayStart: indiaDayStart(iso),
      label: shieldDayLabel(iso, index),
    };
  });
  const aggregate = await store.loadTrafficShieldAggregate(
    userId,
    requestedDays.map(({ slot, iso }) => ({ slot, date: iso })),
  );
  assertAggregate(aggregate);

  const activation = parseStrictUtcTimestamp(aggregate.activationStartedAtUtc);
  let historyTotal = 0n;
  let allExact = activation !== null;
  const days = requestedDays.map((day, index): TrafficShieldDay => {
    const count = aggregate.dailyTotals[index] as bigint;
    if (activation === null) {
      allExact = false;
      return { label: day.label, iso: day.iso, count: null, state: "collecting" };
    }

    if (index === 0) {
      const state = activation.getTime() <= day.dayStart.getTime() ? "exact_so_far" : "collecting";
      if (state !== "exact_so_far") allExact = false;
      historyTotal += count;
      return { label: day.label, iso: day.iso, count: count.toString(), state };
    }

    const nextDayStart = indiaDayStart(shiftIsoDate(day.iso, 1));
    if (activation.getTime() < nextDayStart.getTime()) {
      const state = activation.getTime() <= day.dayStart.getTime() ? "exact" : "collecting";
      if (state !== "exact") allExact = false;
      historyTotal += count;
      return { label: day.label, iso: day.iso, count: count.toString(), state };
    }

    allExact = false;
    return { label: day.label, iso: day.iso, count: null, state: "collecting" };
  });

  return {
    ok: true,
    total: aggregate.lifetimeTotal.toString(),
    history_total: activation === null ? null : historyTotal.toString(),
    history_state: allExact ? "exact" : "collecting",
    history_started_at: activation === null ? null : aggregate.activationStartedAtUtc,
    days,
  };
}

/** Return the exact India business date used by the PHP writer and reader. */
export function indiaBusinessDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: indiaTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = `${map.year ?? ""}-${map.month ?? ""}-${map.day ?? ""}`;
  if (!isIsoDate(date)) throw new RangeError("Could not resolve the India business date.");
  return date;
}

/** Map one event instant to the allowlisted seven-slot India-date ring. */
export function trafficShieldSlot(value: Date): TrafficShieldDateSlot {
  const date = indiaBusinessDate(value);
  return { slot: trafficShieldSlotForDate(date), date };
}

/** Map a validated India date to the PHP ring anchored at Monday 1970-01-05. */
export function trafficShieldSlotForDate(date: string): number {
  const dayNumber = isoDateDayNumber(date);
  const anchor = Math.trunc(Date.UTC(1970, 0, 5) / 86_400_000);
  const delta = dayNumber - anchor;
  return ((delta % filteredHistoryDays) + filteredHistoryDays) % filteredHistoryDays;
}

function assertAggregate(value: TrafficShieldAggregate): void {
  assertUnsignedCounter(value.lifetimeTotal, "lifetime");
  if (value.dailyTotals.length !== filteredHistoryDays) {
    throw new Error("Traffic Shield store returned an incomplete daily aggregate.");
  }
  for (const counter of value.dailyTotals) assertUnsignedCounter(counter, "daily");
  if (value.activationStartedAtUtc !== null && typeof value.activationStartedAtUtc !== "string") {
    throw new Error("Traffic Shield store returned an invalid activation marker.");
  }
}

function assertUnsignedCounter(value: bigint, label: string): void {
  if (typeof value !== "bigint" || value < 0n || value > unsignedCounterMax) {
    throw new Error(`Traffic Shield store returned an invalid ${label} counter.`);
  }
}

function parseStrictUtcTimestamp(value: string | null): Date | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  if (!Number.isSafeInteger(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 19).replace("T", " ") === value ? parsed : null;
}

function indiaDayStart(date: string): Date {
  const parsed = new Date(`${date}T00:00:00${indiaOffset}`);
  if (!Number.isSafeInteger(parsed.getTime())) throw new RangeError("Invalid India day boundary.");
  return parsed;
}

function shiftIsoDate(date: string, days: number): string {
  const shifted = new Date((isoDateDayNumber(date) + days) * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

function shieldDayLabel(date: string, index: number): string {
  if (index === 0) return "Today so far";
  if (index === 1) return "Yesterday";
  const [year, month, day] = isoDateParts(date);
  const weekDay = weekDays[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? "";
  return `${weekDay} ${day} ${months[month - 1] ?? ""}`;
}

function isoDateDayNumber(date: string): number {
  const [year, month, day] = isoDateParts(date);
  return Math.trunc(Date.UTC(year, month - 1, day) / 86_400_000);
}

function isoDateParts(date: string): readonly [number, number, number] {
  if (!isIsoDate(date)) throw new RangeError("Invalid Traffic Shield India date.");
  const [year = 0, month = 0, day = 0] = date.split("-").map(Number);
  const canonical = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  if (canonical !== date) throw new RangeError("Invalid Traffic Shield India date.");
  return [year, month, day];
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
